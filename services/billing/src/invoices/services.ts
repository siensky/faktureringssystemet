// Affärslogik för fakturor (code-style.md #2, #5). Ingen HTTP, inga
// statuskoder utom via BaseError-subklasser.
//
// Regler som bor här:
//   - draft är enda ändringsbara läget; PUT/DELETE mot annat -> 409 (domain.md #1)
//   - fakturanummer + OCR tilldelas vid SEND/CREDIT, inte när utkastet
//     skapas — ett utkast förbrukar inget nummer, så att radera det river
//     inget hål i serien (domain.md #6). Numret tas ur company_settings
//     under radlås i samma transaktion som det tilldelas (domain.md #7),
//     och låset tas så sent som möjligt så det hålls kort.
//   - moms per rad, avrundning en gång på radnivå, totalen = summan av
//     avrundade rader (domain.md #10)
//   - send: snapshot + status draft->sent + invoice.sent via outbox, allt
//     i en transaktion (planens Domänmodell #1)
//   - credit: ny credit_note i settled, originalet -> credited, i en
//     transaktion; kreditraderna är negerade kopior (domain.md #4)

import {
  BadRequest,
  Conflict,
  NotFound,
  type RequestContext,
  UnprocessableEntity,
  deriveOcr,
  writeEvent,
} from "@faktura/shared";
import type { Sql, TransactionSql } from "postgres";
import { writeAuditLog } from "../audit";
import { CompanySettingsRepository } from "../company-settings/repository";
import type { CompanySettingsRow } from "../company-settings/types";
import type { CustomerService } from "../customers/services";
import { addDays, advanceByInterval, dayOfMonth, todayInStockholm } from "../domain/dates";
import { type LineAmounts, computeLine, sumTotals } from "../domain/vat";
import {
  buildSnapshotPayload,
  toDetail,
  toSummary,
  toTemplateDetail,
  toTemplateSummary,
} from "./mappers";
import { type InsertItemData, InvoiceRepository } from "./repository";
import type {
  CreateInvoiceInput,
  CreateInvoiceTemplateInput,
  DeliveryStatus,
  InvoiceRow,
  InvoiceStatus,
  InvoiceTemplateRow,
  LineInputDto,
  UpdateInvoiceInput,
  UpdateInvoiceTemplateInput,
} from "./types";

const SERVICE_NAME = "billing";
// Fas 6: audit_log.actor_user_id har FK mot users(id) — cronens syntetiska
// RequestContext (userId: 0, samma mönster som S2S-kontrollerna) får ALDRIG
// skrivas dit rakt av. Alla revisionsposter från automatiseringen sätter
// actorUserId: null + actorService: "billing-cron" explicit i stället.
const CRON_ACTOR_SERVICE = "billing-cron";
const CREDITABLE: ReadonlySet<InvoiceStatus> = new Set(["sent", "overdue", "paid"]);
// sent/overdue: en faktura kan hinna bli 'overdue' innan cronen når
// påminnelsesteget samma körning, eller redan vara det sedan en tidigare
// dag. Se findReminderCandidates för resten av urvalsvillkoret.
const REMINDABLE: ReadonlySet<InvoiceStatus> = new Set(["sent", "overdue"]);
const PAGE_DEFAULT = 100;
const PAGE_MAX = 200;

function toItems(lines: LineInputDto[]): InsertItemData[] {
  return lines.map((line, i) => {
    const amounts = computeLine({
      quantity: line.quantity,
      unitPriceOre: line.unitPriceOre,
      vatRate: line.vatRate,
    });
    return {
      position: i + 1,
      description: line.description,
      quantity: line.quantity,
      unit: line.unit ?? "st",
      unitPriceOre: line.unitPriceOre,
      vatRate: line.vatRate,
      ...amounts,
    };
  });
}

const amountsOf = (it: InsertItemData): LineAmounts => ({
  lineExclVatOre: it.lineExclVatOre,
  lineVatOre: it.lineVatOre,
  lineInclVatOre: it.lineInclVatOre,
});

/**
 * En momsfri rad om exakt 1 st à `unitPriceOre` — påminnelsens två rader
 * (restskuld + avgift, domain.md #18). Restskulden bär redan moms från
 * originalfakturan (att lägga på moms igen vore dubbelbeskattning), och en
 * påminnelseavgift är ersättning för inkassokostnad, inte en momspliktig
 * leverans.
 */
function zeroVatLine(position: number, description: string, unitPriceOre: number): InsertItemData {
  return {
    position,
    description,
    quantity: 1,
    unit: "st",
    unitPriceOre,
    vatRate: 0,
    ...computeLine({ quantity: 1, unitPriceOre, vatRate: 0 }),
  };
}

/**
 * Följer superseded_by_invoice_id från startRow till kedjans slut (planens
 * Domänmodell #3). Delad av resolveByOcr (startar från findByOcr) och
 * resolveById (startar från findByIdBasic) — payments bokför alltid på
 * kedjans slut, inte på den faktura anroparen faktiskt pekade på.
 */
async function resolveCurrent(repo: InvoiceRepository, startRow: InvoiceRow): Promise<InvoiceRow> {
  let current = startRow;
  const guard = new Set<number>([current.id]);
  while (current.superseded_by_invoice_id) {
    const next = await repo.findByIdBasic(current.superseded_by_invoice_id);
    if (!next || guard.has(next.id)) break;
    guard.add(next.id);
    current = next;
  }
  return current;
}

/** Kastar om datumen är orimliga. dateIssued får inte ligga i framtiden. */
function assertDates(dateIssued: string, dateDue: string): void {
  if (dateIssued > todayInStockholm()) {
    throw new BadRequest("Fakturadatum kan inte ligga i framtiden");
  }
  if (dateDue < dateIssued) {
    throw new BadRequest("Förfallodatum kan inte vara före fakturadatum");
  }
}

/**
 * Motsatt riktning mot assertDates: en mall SCHEMALÄGGER en framtida
 * fakturering, den backdaterar inte en redan levererad tjänst (det är vad
 * ett vanligt utkast är till för). Ett datum i det förflutna skulle bara
 * ligga och vänta på att cronen "kommer ikapp" med ett förvirrande datum
 * på den första genererade fakturan — enklare att avvisa det direkt.
 */
function assertTemplateDate(nextGenerationDate: string): void {
  if (nextGenerationDate < todayInStockholm()) {
    throw new BadRequest("Nästa fakturadatum kan inte ligga i det förflutna");
  }
}

/** Samma momsvalidering (säkert heltalsintervall m.m.) som en vanlig fakturarad — kastar vid ogiltiga rader. */
function assertValidLines(lines: LineInputDto[]): void {
  sumTotals(toItems(lines).map(amountsOf));
}

/** Omlitererar raderna (ingen namngiven interface-typ) innan de skrivs som
 *  JSONB — repo.insertTemplate/updateTemplate förväntar JsonObject, och en
 *  namngiven interface (LineInputDto[] från ./types.ts eller kontraktets
 *  egen) saknar den indexsignaturen. Samma knep som mappers.ts:s
 *  toLineView, fast källan måste vara fräsch här, inte bara returvärdet. */
function toJsonLines(lines: LineInputDto[]) {
  return lines.map((l) => ({
    description: l.description,
    quantity: l.quantity,
    unitPriceOre: l.unitPriceOre,
    vatRate: l.vatRate,
    unit: l.unit ?? "st",
  }));
}

export function createInvoiceService(sql: Sql, customerService: CustomerService) {
  const invRepo = (ctx: RequestContext) => new InvoiceRepository(sql, ctx);
  const csRepo = (ctx: RequestContext) => new CompanySettingsRepository(sql, ctx);

  async function detail(ctx: RequestContext, db: Sql | TransactionSql, id: number) {
    const repo = invRepo(ctx);
    const row = await repo.findById(id, db);
    if (!row) throw new NotFound("Fakturan finns inte");
    const items = await repo.findItems(db, id);
    const paid = row.status === "draft" ? 0 : await repo.paidOre(id, db);
    return toDetail(row, items, paid);
  }

  /**
   * Tar radlåset på nummerserien och returnerar numret, OCR:et och den
   * låsta company_settings-raden (som kreditvägen behöver för snapshoten).
   * Anropa sent i tx:en så låset hålls kort.
   *
   * Samma avsändaruppgifts-grind som sendInTx: en kreditfaktura får också
   * en PDF (domain.md #35), så en admin som blankar ut bankgirot MELLAN
   * att originalet skickades och att det krediteras ska inte kunna
   * producera en trasig kreditfaktura-PDF (PR-granskning fas 4, punkt 26).
   */
  async function allocateNumber(
    ctx: RequestContext,
    tx: TransactionSql,
  ): Promise<{ number: number; ocr: string; settings: CompanySettingsRow }> {
    const settingsRepo = csRepo(ctx);
    const settings = await settingsRepo.lockForUpdate(tx);
    if (!settings.company_name || !settings.org_number || !settings.bankgiro) {
      throw new UnprocessableEntity(
        "Företagsnamn, organisationsnummer och bankgiro måste vara ifyllda innan ett fakturanummer kan tilldelas",
      );
    }
    const number = settings.next_invoice_number;
    await settingsRepo.bumpInvoiceNumber(tx);
    return { number, ocr: deriveOcr(number), settings };
  }

  return {
    async createInTx(ctx: RequestContext, tx: TransactionSql, input: CreateInvoiceInput) {
      const repo = invRepo(ctx);

      // schema.ts (oneOf) garanterar redan exakt en av de två — kollas igen
      // här i stället för att lita blint på det, samma disciplin som
      // repository-basklassens tenant-koll (architecture.md).
      let customerId: number;
      if (input.customerId !== undefined) {
        customerId = input.customerId;
      } else if (input.customer) {
        // Skapas i SAMMA transaktion som fakturan: misslyckas fakturan
        // (t.ex. ogiltiga datum längre ner) rullar den nya kunden tillbaka
        // med den, ingen övergiven kundrad utan faktura.
        const created = await customerService.createInTx(ctx, tx, input.customer);
        customerId = created.body.id;
      } else {
        throw new BadRequest("customerId eller customer måste anges");
      }

      const customer = await repo.findCustomer(customerId, tx);
      if (!customer) throw new BadRequest("Okänd kund");

      const settings = await csRepo(ctx).find();
      const items = toItems(input.lines);
      const totals = sumTotals(items.map(amountsOf));

      const dateIssued = input.dateIssued ?? todayInStockholm();
      const terms = customer.payment_terms_days ?? settings?.payment_terms_days ?? 30;
      const dateDue = input.dateDue ?? addDays(dateIssued, terms);
      assertDates(dateIssued, dateDue);

      const invoice = await repo.insertInvoice(tx, {
        customerId: customer.id,
        invoiceNumber: null, // tilldelas vid send
        ocrNumber: null,
        invoiceType: "invoice",
        status: "draft",
        dateIssued,
        dateDue,
        currency: input.currency ?? "SEK",
        totalExclVatOre: totals.totalExclVatOre,
        totalVatOre: totals.totalVatOre,
        totalInclVatOre: totals.totalInclVatOre,
      });
      await repo.insertItems(tx, invoice.id, items);

      await writeAuditLog(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: "invoice.created",
        resourceType: "invoice",
        resourceId: String(invoice.id),
        correlationId: ctx.correlationId,
        metadata: { totalInclVatOre: totals.totalInclVatOre },
      });

      return { status: 201, body: await detail(ctx, tx, invoice.id) };
    },

    async list(
      ctx: RequestContext,
      opts: { status?: InvoiceStatus; limit?: number; offset?: number },
    ) {
      const limit = Math.min(opts.limit ?? PAGE_DEFAULT, PAGE_MAX);
      const offset = opts.offset ?? 0;
      const rows = await invRepo(ctx).list({ status: opts.status, limit: limit + 1, offset });
      const hasMore = rows.length > limit;
      return { items: rows.slice(0, limit).map(toSummary), hasMore };
    },

    async get(ctx: RequestContext, id: number) {
      return detail(ctx, sql, id);
    },

    /** Fas 8: leveransvyn — samma paginering som list(), filtrerad på delivery_status. */
    async listDeliveries(
      ctx: RequestContext,
      opts: { status?: DeliveryStatus; limit?: number; offset?: number },
    ) {
      const limit = Math.min(opts.limit ?? PAGE_DEFAULT, PAGE_MAX);
      const offset = opts.offset ?? 0;
      const rows = await invRepo(ctx).listByDeliveryStatus({
        deliveryStatus: opts.status,
        limit: limit + 1,
        offset,
      });
      const hasMore = rows.length > limit;
      return { items: rows.slice(0, limit).map(toSummary), hasMore };
    },

    async update(ctx: RequestContext, id: number, input: UpdateInvoiceInput) {
      return sql.begin(async (tx) => {
        const repo = invRepo(ctx);
        const current = await repo.lockById(tx, id);
        if (!current) throw new NotFound("Fakturan finns inte");
        if (current.status !== "draft") {
          throw new Conflict("Endast utkast kan ändras");
        }

        const dateIssued = input.dateIssued ?? current.date_issued;
        const dateDue = input.dateDue ?? current.date_due;
        const currency = input.currency ?? current.currency;
        assertDates(dateIssued, dateDue);

        let totals = {
          totalExclVatOre: Number(current.total_excl_vat_ore),
          totalVatOre: Number(current.total_vat_ore),
          totalInclVatOre: Number(current.total_incl_vat_ore),
        };
        if (input.lines) {
          const items = toItems(input.lines);
          totals = sumTotals(items.map(amountsOf));
          await repo.replaceItems(tx, id, items);
        }

        await repo.updateDraft(tx, id, { dateIssued, dateDue, currency, ...totals });
        await writeAuditLog(tx, {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          action: "invoice.updated",
          resourceType: "invoice",
          resourceId: String(id),
          correlationId: ctx.correlationId,
        });
        return detail(ctx, tx, id);
      });
    },

    async remove(ctx: RequestContext, id: number) {
      return sql.begin(async (tx) => {
        const repo = invRepo(ctx);
        const current = await repo.lockById(tx, id);
        if (!current) throw new NotFound("Fakturan finns inte");
        if (current.status !== "draft") {
          throw new Conflict("Endast utkast kan raderas");
        }
        // Utkast har inget nummer -> ingen lucka i serien.
        await repo.deleteInvoice(tx, id);
        await writeAuditLog(tx, {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          action: "invoice.deleted",
          resourceType: "invoice",
          resourceId: String(id),
          correlationId: ctx.correlationId,
        });
        return { status: "ok" as const };
      });
    },

    async sendInTx(ctx: RequestContext, tx: TransactionSql, id: number) {
      const repo = invRepo(ctx);

      const invoice = await repo.lockById(tx, id);
      if (!invoice) throw new NotFound("Fakturan finns inte");
      if (invoice.status !== "draft") {
        throw new Conflict("Fakturan är redan skickad");
      }

      // Läs allt som inte kräver låset först.
      const customer = await repo.findCustomerFull(invoice.customer_id, tx);
      if (!customer) throw new BadRequest("Fakturans kund saknas");
      const items = await repo.findItems(tx, id);

      // Kritisk sektion: lås company_settings, kontrollera avsändaruppgifter,
      // ta numret, skriv. Hålls kort.
      const settings = await csRepo(ctx).lockForUpdate(tx);
      if (!settings.company_name || !settings.org_number || !settings.bankgiro) {
        throw new UnprocessableEntity(
          "Företagsnamn, organisationsnummer och bankgiro måste vara ifyllda innan en faktura kan skickas",
        );
      }
      const number = settings.next_invoice_number;
      const ocr = deriveOcr(number);
      await csRepo(ctx).bumpInvoiceNumber(tx);
      await repo.markSent(tx, id, number, ocr);

      const sentInvoice: InvoiceRow = {
        ...invoice,
        invoice_number: number,
        ocr_number: ocr,
        status: "sent",
      };
      const payload = buildSnapshotPayload({
        invoice: sentInvoice,
        items,
        company: settings,
        customer,
      });
      await repo.insertSnapshot(tx, id, payload);

      await writeEvent(tx, {
        sourceService: SERVICE_NAME,
        eventType: "invoice.sent",
        tenantId: ctx.tenantId,
        correlationId: ctx.correlationId,
        payload: { invoiceId: id },
      });
      await writeAuditLog(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: "invoice.sent",
        resourceType: "invoice",
        resourceId: String(id),
        correlationId: ctx.correlationId,
        metadata: { invoiceNumber: number },
      });

      return { status: 200, body: await detail(ctx, tx, id) };
    },

    async creditInTx(ctx: RequestContext, tx: TransactionSql, id: number) {
      const repo = invRepo(ctx);

      const original = await repo.lockById(tx, id);
      if (!original) throw new NotFound("Fakturan finns inte");
      if (original.invoice_type !== "invoice") {
        throw new Conflict("Bara vanliga fakturor kan krediteras");
      }
      if (!CREDITABLE.has(original.status)) {
        throw new Conflict("Fakturan är i ett läge som inte kan krediteras");
      }

      const originalItems = await repo.findItems(tx, id);
      const creditItems: InsertItemData[] = originalItems.map((it, i) => ({
        position: i + 1,
        description: it.description,
        // Kreditraden speglar originalraden med ombytt tecken (domain.md #4).
        quantity: -Number(it.quantity),
        unit: it.unit,
        unitPriceOre: Number(it.unit_price_ore),
        vatRate: Number(it.vat_rate),
        lineExclVatOre: -Number(it.line_excl_vat_ore),
        lineVatOre: -Number(it.line_vat_ore),
        lineInclVatOre: -Number(it.line_incl_vat_ore),
      }));
      const totals = sumTotals(creditItems.map(amountsOf));

      // Kreditfakturan skickas till kunden som PDF (domain.md #35) och
      // documents renderar ur snapshoten, aldrig de levande tabellerna —
      // så kundraden behövs för adressblocket redan här.
      const customer = await repo.findCustomerFull(original.customer_id, tx);
      if (!customer) throw new BadRequest("Fakturans kund saknas");

      // Kritisk sektion: nummerserien. settings används till snapshoten nedan.
      const { number, ocr, settings } = await allocateNumber(ctx, tx);

      const today = todayInStockholm();
      const creditNote = await repo.insertInvoice(tx, {
        customerId: original.customer_id,
        invoiceNumber: number,
        ocrNumber: ocr,
        invoiceType: "credit_note",
        status: "settled",
        dateIssued: today,
        dateDue: today,
        currency: original.currency,
        totalExclVatOre: totals.totalExclVatOre,
        totalVatOre: totals.totalVatOre,
        totalInclVatOre: totals.totalInclVatOre,
        creditsInvoiceId: original.id,
      });
      await repo.insertItems(tx, creditNote.id, creditItems);
      await repo.setStatus(tx, original.id, "credited");

      // Frusen kopia för PDF-rendering (database.md #30), på samma form som
      // send-vägen skriver. Läs tillbaka de nyss insatta raderna så
      // snapshoten får exakt DB-formen (öre som öre), inte de negerade
      // InsertItemData-talen.
      const creditRows = await repo.findItems(tx, creditNote.id);
      await repo.insertSnapshot(
        tx,
        creditNote.id,
        buildSnapshotPayload({
          invoice: creditNote,
          items: creditRows,
          company: settings,
          customer,
        }),
      );

      await writeEvent(tx, {
        sourceService: SERVICE_NAME,
        eventType: "invoice.credited",
        tenantId: ctx.tenantId,
        correlationId: ctx.correlationId,
        payload: { invoiceId: creditNote.id, creditsInvoiceId: original.id },
      });
      await writeAuditLog(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: "invoice.credited",
        resourceType: "invoice",
        resourceId: String(original.id),
        correlationId: ctx.correlationId,
        metadata: { creditNoteId: creditNote.id, creditNumber: number },
      });

      return { status: 201, body: await detail(ctx, tx, creditNote.id) };
    },

    /** S2S: snapshotens payload för documents. 404 om ingen snapshot. */
    async getSnapshot(ctx: RequestContext, id: number) {
      const snap = await invRepo(ctx).findSnapshot(id);
      if (!snap) throw new NotFound("Ingen snapshot för fakturan");
      return snap;
    },

    /**
     * S2S: OCR -> aktuell faktura, med kedjeföljning av
     * superseded_by_invoice_id (planens Domänmodell #3). payments bokför
     * betalningen på currentInvoiceId, inte på den OCR pekar på.
     */
    async resolveByOcr(ctx: RequestContext, ocr: string) {
      const repo = invRepo(ctx);
      const matched = await repo.findByOcr(ocr);
      if (!matched) throw new NotFound("Ingen faktura med det OCR-numret");
      const current = await resolveCurrent(repo, matched);

      const paidOre = await repo.paidOre(current.id);
      const totalInclVatOre = Number(current.total_incl_vat_ore);
      return {
        matchedInvoiceId: matched.id,
        currentInvoiceId: current.id,
        ocr,
        customerId: current.customer_id,
        status: current.status,
        currency: current.currency,
        totalInclVatOre,
        paidOre,
        remainingOre: totalInclVatOre - paidOre,
      };
    },

    /**
     * S2S: id -> aktuell faktura, med samma kedjeföljning som
     * resolveByOcr. Används av payments admin-matchning för att verifiera
     * ett admin-angivet invoiceId mot en LEVANDE remainingOre (domain.md
     * #27) i stället för ett klientskickat belopp.
     */
    async resolveById(ctx: RequestContext, id: number) {
      const repo = invRepo(ctx);
      const start = await repo.findByIdBasic(id);
      if (!start) throw new NotFound("Fakturan finns inte");
      const current = await resolveCurrent(repo, start);

      const paidOre = await repo.paidOre(current.id);
      const totalInclVatOre = Number(current.total_incl_vat_ore);
      return {
        currentInvoiceId: current.id,
        customerId: current.customer_id,
        status: current.status,
        currency: current.currency,
        totalInclVatOre,
        paidOre,
        remainingOre: totalInclVatOre - paidOre,
      };
    },

    // ── Fas 6: automatisering ──────────────────────────────────────────

    /** sent -> overdue. Returnerar antalet markerade fakturor. */
    async markOverdue(ctx: RequestContext, today: string): Promise<number> {
      return invRepo(ctx).markOverdueBulk(today);
    },

    /** Läsning inför loopen i automation/service.ts — själva skapandet låser per rad. */
    async listReminderCandidates(ctx: RequestContext, today: string): Promise<InvoiceRow[]> {
      return invRepo(ctx).findReminderCandidates(today);
    },

    /**
     * Skapar en påminnelsefaktura för `originalId` och sätter originalet
     * `superseded`, i EN transaktion (planens Domänmodell #3). Radlåset på
     * originalet (lockById, FOR UPDATE) är det som gör "två körningar i
     * rad ger ingen dubbelpåminnelse" sant även vid en race mellan två
     * samtidiga körningar — inte bara NOT EXISTS-villkoret i urvalet, som
     * bara skyddar mot sekventiella körningar.
     *
     * Beloppet är restskulden plus påminnelseavgiften (domain.md #18) — se
     * zeroVatLine för varför båda raderna är momsfria.
     *
     * Publicerar ETT EGET event, invoice.reminder_sent — inte invoice.sent
     * (fas 14). documents grenar på eventtypen (document_type/email_type
     * 'reminder') så att en påminnelse får sin egen PDF-rubrik, ämnesrad
     * och brevtext i stället för att se ut som en vanlig faktura.
     */
    async createReminderInTx(
      ctx: RequestContext,
      tx: TransactionSql,
      originalId: number,
      today: string,
    ): Promise<{ created: boolean; reminderInvoiceId?: number }> {
      const repo = invRepo(ctx);

      const original = await repo.lockById(tx, originalId);
      if (!original) return { created: false };
      // Försvar mot en race med en samtidig körning som redan hann före:
      // återkontrollera ALLT urvalsvillkoret under låset, inte bara läs det.
      if (original.invoice_type !== "invoice") return { created: false };
      if (!REMINDABLE.has(original.status)) return { created: false };
      if (original.reminds_invoice_id || original.superseded_by_invoice_id)
        return { created: false };

      const paidOre = await repo.paidOre(original.id, tx);
      const remainingOre = Number(original.total_incl_vat_ore) - paidOre;
      if (remainingOre <= 0) return { created: false }; // hann bli betald under tiden

      const customer = await repo.findCustomerFull(original.customer_id, tx);
      if (!customer) throw new BadRequest("Fakturans kund saknas");

      // Kritisk sektion: nummerserien. settings ger reminder_fee_ore + snapshoten.
      const { number, ocr, settings } = await allocateNumber(ctx, tx);

      const items: InsertItemData[] = [
        zeroVatLine(1, `Resterande belopp faktura ${original.invoice_number}`, remainingOre),
        zeroVatLine(2, "Påminnelseavgift", Number(settings.reminder_fee_ore)),
      ];
      const totals = sumTotals(items.map(amountsOf));

      const terms = customer.payment_terms_days ?? settings.payment_terms_days;
      const dateDue = addDays(today, terms);

      const reminder = await repo.insertInvoice(tx, {
        customerId: original.customer_id,
        invoiceNumber: number,
        ocrNumber: ocr,
        invoiceType: "reminder",
        status: "sent",
        dateIssued: today,
        dateDue,
        currency: original.currency,
        totalExclVatOre: totals.totalExclVatOre,
        totalVatOre: totals.totalVatOre,
        totalInclVatOre: totals.totalInclVatOre,
        remindsInvoiceId: original.id,
      });
      await repo.insertItems(tx, reminder.id, items);
      await repo.supersede(tx, original.id, reminder.id);

      const reminderRows = await repo.findItems(tx, reminder.id);
      await repo.insertSnapshot(
        tx,
        reminder.id,
        buildSnapshotPayload({
          invoice: reminder,
          items: reminderRows,
          company: settings,
          customer,
          remindsInvoice: original,
        }),
      );

      await writeEvent(tx, {
        sourceService: SERVICE_NAME,
        eventType: "invoice.reminder_sent",
        tenantId: ctx.tenantId,
        correlationId: ctx.correlationId,
        payload: { invoiceId: reminder.id, remindsInvoiceId: original.id },
      });

      await writeAuditLog(tx, {
        tenantId: ctx.tenantId,
        actorUserId: null,
        actorService: CRON_ACTOR_SERVICE,
        action: "invoice.reminder_created",
        resourceType: "invoice",
        resourceId: String(original.id),
        correlationId: ctx.correlationId,
        metadata: {
          reminderInvoiceId: reminder.id,
          reminderNumber: number,
          remainingOre,
          feeOre: Number(settings.reminder_fee_ore),
        },
      });

      return { created: true, reminderInvoiceId: reminder.id };
    },

    /** Läsning inför loopen — mallar mogna att generera. */
    async listDueTemplates(ctx: RequestContext, today: string): Promise<InvoiceTemplateRow[]> {
      return invRepo(ctx).findDueTemplates(today);
    },

    /**
     * Genererar en faktura ur en återkommande mall och rullar fram
     * next_generation_date, i EN transaktion. Radlåset på mallraden
     * (lockTemplate, FOR UPDATE) gör det säkert mot samma race som
     * createReminderInTx skyddar mot.
     *
     * dateIssued blir mallens SCHEMALAGDA datum (next_generation_date), inte
     * dagens datum — annars driver schemat iväg om cronen någon dag körs
     * sent eller missar en körning. Publicerar invoice.sent: en genererad
     * återkommande faktura ÄR en vanlig faktura, och dokumentet/mejlet ska
     * se exakt likadant ut som om en admin tryckt skicka för hand.
     */
    async generateFromTemplateInTx(
      ctx: RequestContext,
      tx: TransactionSql,
      templateId: number,
      today: string,
    ): Promise<{ created: boolean; invoiceId?: number }> {
      const repo = invRepo(ctx);

      const template = await repo.lockTemplate(tx, templateId);
      if (!template) return { created: false };
      if (!template.is_active || template.next_generation_date > today) return { created: false };

      const customer = await repo.findCustomerFull(template.customer_id, tx);
      if (!customer) throw new BadRequest("Mallens kund saknas");

      const dateIssued = template.next_generation_date;
      const terms =
        customer.payment_terms_days ?? (await csRepo(ctx).find())?.payment_terms_days ?? 30;
      const dateDue = addDays(dateIssued, terms);

      const items = toItems(template.template_data.lines);
      const totals = sumTotals(items.map(amountsOf));

      const { number, ocr, settings } = await allocateNumber(ctx, tx);

      const invoice = await repo.insertInvoice(tx, {
        customerId: template.customer_id,
        invoiceNumber: number,
        ocrNumber: ocr,
        invoiceType: "invoice",
        status: "sent",
        dateIssued,
        dateDue,
        currency: template.template_data.currency ?? "SEK",
        totalExclVatOre: totals.totalExclVatOre,
        totalVatOre: totals.totalVatOre,
        totalInclVatOre: totals.totalInclVatOre,
        parentTemplateId: template.id,
      });
      await repo.insertItems(tx, invoice.id, items);

      const invoiceItems = await repo.findItems(tx, invoice.id);
      await repo.insertSnapshot(
        tx,
        invoice.id,
        buildSnapshotPayload({ invoice, items: invoiceItems, company: settings, customer }),
      );

      await writeEvent(tx, {
        sourceService: SERVICE_NAME,
        eventType: "invoice.sent",
        tenantId: ctx.tenantId,
        correlationId: ctx.correlationId,
        payload: { invoiceId: invoice.id },
      });
      await writeAuditLog(tx, {
        tenantId: ctx.tenantId,
        actorUserId: null,
        actorService: CRON_ACTOR_SERVICE,
        action: "invoice.generated_recurring",
        resourceType: "invoice",
        resourceId: String(invoice.id),
        correlationId: ctx.correlationId,
        metadata: { templateId: template.id, invoiceNumber: number },
      });

      await repo.advanceTemplateDate(
        tx,
        template.id,
        advanceByInterval(template.next_generation_date, template.interval, template.billing_day),
      );

      return { created: true, invoiceId: invoice.id };
    },

    // --- Fas 13: admin-CRUD på mallar. Generatorn ovan (listDueTemplates/
    // generateFromTemplateInTx) fanns redan sedan fas 6 — det som saknades
    // var ett sätt att FÅ en mall att existera i första läget.

    async createTemplateInTx(
      ctx: RequestContext,
      tx: TransactionSql,
      input: CreateInvoiceTemplateInput,
    ) {
      const repo = invRepo(ctx);
      const customer = await repo.findCustomer(input.customerId, tx);
      if (!customer) throw new BadRequest("Okänd kund");

      assertTemplateDate(input.nextGenerationDate);
      assertValidLines(input.lines);

      const row = await repo.insertTemplate(tx, {
        customerId: customer.id,
        interval: input.interval,
        nextGenerationDate: input.nextGenerationDate,
        billingDay: dayOfMonth(input.nextGenerationDate),
        templateData: {
          customerId: customer.id,
          currency: input.currency ?? "SEK",
          lines: toJsonLines(input.lines),
        },
      });
      await writeAuditLog(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: "invoice_template.created",
        resourceType: "invoice_template",
        resourceId: String(row.id),
        correlationId: ctx.correlationId,
      });
      return { status: 201, body: toTemplateDetail({ ...row, customer_name: customer.name }) };
    },

    async listTemplates(ctx: RequestContext) {
      const rows = await invRepo(ctx).listTemplates();
      return rows.map(toTemplateSummary);
    },

    async getTemplate(ctx: RequestContext, id: number) {
      const row = await invRepo(ctx).findTemplateById(id);
      if (!row) throw new NotFound("Mallen finns inte");
      return toTemplateDetail(row);
    },

    async updateTemplate(ctx: RequestContext, id: number, input: UpdateInvoiceTemplateInput) {
      return sql.begin(async (tx) => {
        const repo = invRepo(ctx);
        const current = await repo.findTemplateById(id, tx);
        if (!current) throw new NotFound("Mallen finns inte");

        const nextGenerationDate = input.nextGenerationDate ?? current.next_generation_date;
        if (input.nextGenerationDate) assertTemplateDate(input.nextGenerationDate);
        const lines = input.lines ?? current.template_data.lines;
        assertValidLines(lines);

        const interval = input.interval ?? current.interval;
        const billingDay = input.nextGenerationDate
          ? dayOfMonth(input.nextGenerationDate)
          : current.billing_day;
        const isActive = input.isActive ?? current.is_active;
        const currency = input.currency ?? current.template_data.currency ?? "SEK";
        const jsonLines = toJsonLines(lines);

        await repo.updateTemplate(tx, id, {
          interval,
          nextGenerationDate,
          billingDay,
          templateData: { customerId: current.customer_id, currency, lines: jsonLines },
          isActive,
        });
        await writeAuditLog(tx, {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          action: "invoice_template.updated",
          resourceType: "invoice_template",
          resourceId: String(id),
          correlationId: ctx.correlationId,
        });
        return toTemplateDetail({
          ...current,
          interval,
          next_generation_date: nextGenerationDate,
          billing_day: billingDay,
          is_active: isActive,
          template_data: { customerId: current.customer_id, currency, lines: jsonLines },
        });
      });
    },

    async removeTemplate(ctx: RequestContext, id: number) {
      return sql.begin(async (tx) => {
        const repo = invRepo(ctx);
        const current = await repo.findTemplateById(id, tx);
        if (!current) throw new NotFound("Mallen finns inte");
        await repo.deleteTemplate(tx, id);
        await writeAuditLog(tx, {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          action: "invoice_template.deleted",
          resourceType: "invoice_template",
          resourceId: String(id),
          correlationId: ctx.correlationId,
        });
        return { status: "ok" as const };
      });
    },
  };
}

export type InvoiceService = ReturnType<typeof createInvoiceService>;
