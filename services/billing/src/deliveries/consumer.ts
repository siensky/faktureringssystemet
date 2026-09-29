// RabbitMQ-konsument för invoice.delivery_updated (från documents).
//
// Egen kanal, inte den delade `rabbit.channel` — så prefetch(1) här inte
// också strypar system-pingens konsument på samma kanal. Kanalen stängs i
// onClose-haken i index.ts.
//
// Felhantering:
//   - ogiltig envelope/payload  -> ack (permanent skräp, ska inte requeuas
//                                   i all evighet). Loggas som error.
//   - övrigt fel (t.ex. DB nere) -> ETT nytt försök, räknat i ett
//                                   x-attempts-headerfält på meddelandet —
//                                   INTE amqplibs `redelivered`-flagga.
//                                   Den sätts även vid en vanlig omstart
//                                   eller rullande deploy, oavsett om något
//                                   bearbetningsförsök alls gjorts, och
//                                   skulle då ge upp redan på det första
//                                   riktiga försöket (typiskt just när
//                                   billing/S3/DB inte är varma än).
//                                   Försöket görs om genom att ack:a
//                                   originalet och publicera en kopia med
//                                   x-attempts+1 till samma kö — headern
//                                   överlever en omstart, till skillnad
//                                   från redelivered. Efter MAX_ATTEMPTS
//                                   ges meddelandet upp: nack (inte ack)
//                                   med requeue=false, larm loggas, och
//                                   meddelandet dead-lettras till
//                                   events.dlx/events.dlq
//                                   (infra/rabbitmq/init.sh) i stället
//                                   för att kastas bort — så en förgiftad
//                                   rad inte loopar hett OCH inte
//                                   försvinner spårlöst (PR-granskning
//                                   fas 5, punkt 6). Larm PÅ dead-letter-
//                                   kön (inte bara i loggen) läggs till i
//                                   fas 7.

import {
  EnvelopeValidationError,
  type InvoiceDeliveryUpdatedPayload,
  PayloadValidationError,
  assertValidEnvelope,
  assertValidPayload,
} from "@faktura/contracts";
import type { Logger, RabbitConnection } from "@faktura/shared";
import type { Channel, ConsumeMessage } from "amqplib";
import type { DeliveryService } from "./service";

const EXCHANGE = "events";
const QUEUE = "billing.events";
const ROUTING_KEYS = ["invoice.delivery_updated"];
const REQUEUE_DELAY_MS = 1000;
const ATTEMPTS_HEADER = "x-attempts";
const MAX_ATTEMPTS = 3;
// Måste vara IDENTISKA med infra/rabbitmq/init.sh:s förhandsdeklaration —
// RabbitMQ ger PRECONDITION_FAILED om en redeklaration har andra
// argument. Se init.sh för varför de sätts nu, innan de behövs.
const QUEUE_ARGUMENTS = { "x-dead-letter-exchange": "events.dlx" };

export interface DeliveryConsumer {
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startDeliveryConsumer(opts: {
  rabbit: RabbitConnection;
  service: DeliveryService;
  logger: Logger;
}): Promise<DeliveryConsumer> {
  const { rabbit, service, logger } = opts;
  const channel: Channel = await rabbit.connection.createChannel();
  // EGEN kanal för republishWithAttempt, skild från konsumtionskanalen.
  // prefetch(1) begränsar billing till ett meddelande i taget här, men
  // documents motsvarighet (prefetch 5) visade sig i praktiken kunna
  // tappa hela konsumentregistreringen när flera samtidiga _on_message-
  // anrop publicerade på samma kanal som aktivt konsumerade — samma
  // försiktighetsåtgärd här, även vid prefetch(1), så de två sidorna inte
  // kan glida isär i beteende senare.
  const republishChannel: Channel = await rabbit.connection.createChannel();

  // 'events' deklareras EN gång av infra/rabbitmq/init.sh (durable topic).
  // billing-kontot har medvetet inte 'configure' på det (se init.sh), så vi
  // deklarerar det aldrig här — bara binder vår egen kö mot det.
  await channel.assertQueue(QUEUE, { durable: true, arguments: QUEUE_ARGUMENTS });
  for (const key of ROUTING_KEYS) {
    await channel.bindQueue(QUEUE, EXCHANGE, key);
  }
  await channel.prefetch(1);

  const republishWithAttempt = async (msg: ConsumeMessage, attempts: number): Promise<void> => {
    // Publicerar en KOPIA till vår egen kö (default-exchange, routing key
    // = könamnet) med x-attempts satt, ack:ar originalet. Se moduldocen
    // för varför detta ersätter redelivered-heuristiken.
    republishChannel.publish("", QUEUE, msg.content, {
      ...msg.properties,
      headers: { ...msg.properties.headers, [ATTEMPTS_HEADER]: attempts },
      persistent: true,
    });
    channel.ack(msg);
  };

  const onMessage = async (msg: ConsumeMessage | null): Promise<void> => {
    if (!msg) return;
    const attempts = Number(msg.properties.headers?.[ATTEMPTS_HEADER] ?? 0);
    try {
      const envelope = JSON.parse(msg.content.toString("utf8"));
      assertValidEnvelope(envelope);
      assertValidPayload(envelope.eventType, envelope.payload);
      // Payloaden är nu validerad mot invoice-delivery-updated.schema.json
      // — casten är trygg. assertValidPayload är generisk över alla
      // eventtyper och kan inte smalna typen på egen hand.
      const payload = envelope.payload as InvoiceDeliveryUpdatedPayload;

      const outcome = await service.apply({
        eventId: envelope.eventId,
        tenantId: envelope.tenantId,
        correlationId: envelope.correlationId,
        payload,
      });

      logger.info(
        {
          eventId: envelope.eventId,
          invoiceId: payload.invoiceId,
          deliveryStatus: payload.deliveryStatus,
          applied: outcome.applied,
          statusAdvanced: outcome.statusAdvanced,
          emailInvalidated: outcome.emailInvalidated,
        },
        "delivery-consumer: invoice.delivery_updated hanterat",
      );
      channel.ack(msg);
    } catch (error) {
      if (error instanceof EnvelopeValidationError || error instanceof PayloadValidationError) {
        logger.error({ err: error }, "delivery-consumer: ogiltigt event, kastas utan requeue");
        channel.ack(msg);
        return;
      }
      const nextAttempts = attempts + 1;
      if (nextAttempts >= MAX_ATTEMPTS) {
        logger.error(
          { err: error, attempts: nextAttempts },
          "delivery-consumer: transient fel, gav upp efter maxantal försök — dead-lettrar",
        );
        // nack (inte ack!) med requeue=false: det är DET som faktiskt
        // dead-lettrar meddelandet till events.dlx/events.dlq
        // (infra/rabbitmq/init.sh). Ett ack hade bara kastat bort det —
        // dead-letter-infrastrukturen fanns byggd men användes aldrig på
        // den enda väg som behöver den (PR-granskning fas 5, punkt 6).
        channel.nack(msg, false, false);
        return;
      }
      logger.warn(
        { err: error, attempts: nextAttempts },
        "delivery-consumer: transient fel, försöker igen",
      );
      await sleep(REQUEUE_DELAY_MS);
      try {
        await republishWithAttempt(msg, nextAttempts);
      } catch (republishError) {
        // onMessage anropas som "void onMessage(msg)" i channel.consume
        // nedan — ett ofångat fel här (t.ex. en kanal/anslutning som
        // stängts mitt i) skulle bli en unhandled rejection som Bun
        // tolkar som fatal och kraschar HELA billing-processen för en
        // enda meddelandeleverans (upptäckt under PR-granskning fas 5
        // via services/billing/src/payments/consumer.ts — samma
        // "void onMessage"-mönster, samma risk). Fångas lokalt i
        // stället: meddelandet lämnas medvetet ounquittat, RabbitMQ
        // levererar om det när kanalen/anslutningen återupprättas.
        logger.error(
          { err: republishError, attempts: nextAttempts },
          "delivery-consumer: KRITISKT — kunde inte ompublicera för nytt försök, lämnar meddelandet ounquittat",
        );
      }
    }
  };

  const { consumerTag } = await channel.consume(QUEUE, (msg) => {
    void onMessage(msg);
  });

  return {
    async stop() {
      try {
        await channel.cancel(consumerTag);
        await channel.close();
        await republishChannel.close();
      } catch (error) {
        logger.warn({ err: error }, "delivery-consumer: fel vid nedstängning");
      }
    },
  };
}
