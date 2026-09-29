// ALL affärslogik för auth-modulen (code-style.md #2). Ingen HTTP här —
// metoderna kastar BaseError-subklasser, controllern/felhanteraren
// översätter (code-style.md #5).

import { randomUUID } from "node:crypto";
import {
  BadRequest,
  Conflict,
  Forbidden,
  NotFound,
  USER_TOKEN,
  Unauthorized,
  signAccessToken,
} from "@faktura/shared";
import type { Logger, RequestContext } from "@faktura/shared";
import type Redis from "ioredis";
import type { Sql } from "postgres";
import { writeAuditLog } from "../audit";
import { createBankIdRepository } from "../bankid/repository";
import { findCustomer } from "../billing-client";
import type { config as Config } from "../config";
import { SERVICE_NAME } from "../config";
import { writeEvent } from "../outbox";
import { generateToken, hashPassword, hashToken, verifyPassword } from "../passwords";
import { createSessionIssuer } from "../session";
import { assertNotLockedOut, clearLoginFailures, recordLoginFailure } from "../throttle";
import { OK, toCurrentUserView, toTokenPairResponse } from "./mappers";
import { createAuthRepository } from "./repository";
import type {
  AcceptCustomerInviteInput,
  CreateCustomerInviteInput,
  LoginInput,
  RegisterInput,
  TenantStatus,
  TokenType,
} from "./types";

interface Deps {
  sql: Sql;
  redis: Redis;
  config: typeof Config;
  logger: Logger;
}

const norm = (email: string) => email.trim().toLowerCase();

export function createAuthService(deps: Deps) {
  const { sql, redis, config, logger } = deps;
  const repo = createAuthRepository(sql);
  const bankIdRepo = createBankIdRepository(sql);
  const sessionIssuer = createSessionIssuer({ sql, config });

  // Argon2-hash att verifiera mot när användaren inte finns, så svarstiden
  // inte skvallrar om en e-post existerar (planens enumereringsskydd).
  let dummyHash: string | undefined;
  const getDummyHash = async (): Promise<string> => {
    if (!dummyHash) dummyHash = await hashPassword(randomUUID());
    return dummyHash;
  };

  const ttlFor = (type: TokenType): number => {
    if (type === "email_verification") return config.emailVerificationTtlSeconds;
    if (type === "customer_invite") return config.customerInviteTtlSeconds;
    return config.passwordResetTtlSeconds;
  };

  async function issueTokenRow(
    userId: number,
    tenantId: number,
    type: TokenType,
    ttlSeconds: number,
    db: Parameters<typeof repo.insertToken>[0] = sql,
  ): Promise<string> {
    const plain = generateToken();
    await repo.insertToken(db, {
      tenantId,
      userId,
      tokenType: type,
      tokenHash: hashToken(plain, config.tokenPepper),
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    });
    return plain;
  }

  async function assertTenantActive(tenantId: number): Promise<void> {
    const status: TenantStatus | undefined = await repo.getTenantStatus(tenantId);
    if (status !== "active") {
      // Kallaren ÄR rätt identifierad men saknar behörighet -> 403, inte 404
      // (code-style.md #14).
      throw new Forbidden("Kontot är avstängt");
    }
  }

  return {
    async register(input: RegisterInput, correlationId?: string) {
      const email = norm(input.email);
      // Hashen görs ALLTID (dominerar svarstiden), oavsett utfall — så en
      // upptagen e-post inte kan skiljas från en ledig på timing.
      const passwordHash = await hashPassword(input.password);

      try {
        // Ingen förhandskoll: försök insert:en direkt i transaktionen och
        // fånga unique-violation. En TOCTOU-koll utanför transaktionen gör
        // att två samtidiga registreringar på samma e-post ger 500 för den
        // andra — vilket är precis den enumeringssignal konstruktionen ska
        // ta bort.
        await sql.begin(async (tx) => {
          const { tenantId, userId } = await repo.insertTenantAndAdmin(tx, {
            companyName: input.companyName,
            orgNumber: input.orgNumber,
            email,
            passwordHash,
          });
          await issueTokenRow(
            userId,
            tenantId,
            "email_verification",
            config.emailVerificationTtlSeconds,
            tx,
          );
          await writeEvent(tx, {
            sourceService: SERVICE_NAME,
            eventType: "tenant.created",
            tenantId,
            correlationId,
            payload: { tenantId, adminUserId: userId },
          });
          await writeAuditLog(tx, {
            tenantId,
            actorUserId: userId,
            action: "tenant.registered",
            resourceType: "tenant",
            resourceId: String(tenantId),
            correlationId,
          });
        });
      } catch (error) {
        // 23505 = unique_violation (e-post eller org_number redan taget).
        // Enumeringssäkert: samma OK-svar som vid en lyckad registrering.
        if ((error as { code?: string }).code === "23505") {
          logger.info({}, "register: e-post eller orgnr redan taget, ingen åtgärd");
        } else {
          throw error;
        }
      }

      return OK;
    },

    async verifyEmail(token: string) {
      const row = await repo.findToken(hashToken(token, config.tokenPepper), "email_verification");
      if (!row || row.used_at || row.expires_at.getTime() < Date.now()) {
        throw new BadRequest("Ogiltig eller utgången token");
      }
      await sql.begin(async (tx) => {
        // markTokenUsed har `AND used_at IS NULL` — 0 rader betyder att en
        // parallell request hann förbruka token först.
        if ((await repo.markTokenUsed(tx, row.id)) === 0) {
          throw new BadRequest("Ogiltig eller utgången token");
        }
        await repo.setEmailVerified(tx, row.user_id);
      });
      return OK;
    },

    async login(input: LoginInput) {
      const email = norm(input.email);
      await assertNotLockedOut(redis, email);

      const user = await repo.findUserByEmailForLogin(email);
      const hash = user?.password_hash ?? (await getDummyHash());
      const passwordOk = await verifyPassword(input.password, hash);

      if (!user || !passwordOk) {
        await recordLoginFailure(redis, email);
        throw new Unauthorized("Fel e-post eller lösenord");
      }
      if (!user.email_verified_at) {
        throw new Forbidden("E-postadressen är inte verifierad");
      }
      await assertTenantActive(user.tenant_id);
      await clearLoginFailures(redis, email);
      return sessionIssuer.issue(user);
    },

    /** Fas 8: GET /auth/me. userId/tenantId kommer redan verifierade ur access-token. */
    async me(ctx: RequestContext) {
      // Fas 12: en BankID-kundidentitets users.tenant_id är NULL, så
      // huvudvägen (WHERE u.tenant_id = tenantId) matchar aldrig en sådan
      // rad — se findBankIdCustomerContext.
      const primary = await repo.findUserWithTenantById(ctx.userId, ctx.tenantId);
      const row = primary ?? (await repo.findBankIdCustomerContext(ctx.userId, ctx.tenantId));
      if (!row) throw new NotFound("Användaren finns inte");

      // Bara en BankID-kundidentitet kan vara länkad till flera företag —
      // och just det är signalen att veta att det ÄR en, utan en extra
      // auth_method-kolumn: primary matchar per konstruktion aldrig en
      // sådan rad, så att den missade betyder att reservvägen gjorde det.
      // Undviker en extra DB-fråga för varje lösenordskund (kodgranskning
      // fas 12) — role === "customer" ensamt skulle triggat den även för dem.
      const companies = !primary ? await bankIdRepo.listCompanyLinks(ctx.userId) : undefined;

      // Kundens eget namn bor i billings customers-tabell, inte här —
      // samma S2S-uppslag POST /auth/customer-invites redan använder för
      // att validera customerId (findCustomer). En läsning, degraderar
      // snarare än slår fel: /auth/me anropas vid varje sidladdning
      // (AuthContext), och ett kort billing-hack ska inte kunna logga ut
      // en kund som redan har en giltig session — samma resonemang som
      // overview()s Promise.allSettled för ett enskilt trögt företag.
      let customerName: string | null = null;
      if (row.customer_id !== null) {
        try {
          const customer = await findCustomer(
            redis,
            row.tenant_id,
            row.customer_id,
            ctx.correlationId,
          );
          customerName = customer?.name ?? null;
        } catch (error) {
          logger.warn(
            { err: error, userId: ctx.userId, customerId: row.customer_id },
            "auth/me: kunde inte hämta kundens namn från billing, degraderar utan det",
          );
        }
      }

      return toCurrentUserView(row, companies?.length ? companies : undefined, customerName);
    },

    async refresh(refreshToken: string) {
      const row = await repo.findToken(hashToken(refreshToken, config.tokenPepper), "refresh");
      if (!row) throw new Unauthorized("Ogiltigt token");

      if (row.used_at) {
        // Ett redan roterat refresh-token presenteras igen -> möjlig stöld.
        // Avsluta alla sessioner för användaren.
        await sql.begin((tx) => repo.revokeTokens(tx, row.user_id, "refresh"));
        throw new Unauthorized("Token återanvänt — alla sessioner avslutade");
      }
      if (row.expires_at.getTime() < Date.now()) {
        throw new Unauthorized("Token har gått ut");
      }

      const user = await repo.findUserById(row.user_id);
      if (!user) throw new Unauthorized("Användaren finns inte");
      // Fas 12: user.tenant_id är NULL på en BankID-kundidentitets egen rad
      // (den har ingen "hemma-tenant", bara länkar) — den SESSIONEN hör
      // till tenanten är row.tenant_id, redan korrekt satt av
      // sessionIssuer.issue() när tokenet först utfärdades (session.ts).
      // Samma rättning som GET /auth/me fick (findBankIdCustomerContext).
      await assertTenantActive(row.tenant_id);

      // Av samma skäl: users.customer_id är också NULL för en BankID-
      // kundidentitet — kundkopplingen för DEN HÄR tenanten ligger i
      // user_company_links, inte på identitetens egen rad.
      const customerId =
        user.customer_id ??
        (user.role === "customer"
          ? (await bankIdRepo.findLink(user.id, row.tenant_id))?.customer_id
          : undefined);
      if (user.role === "customer" && customerId == null) {
        // Länken till den här tenanten är borta sedan tokenet utfärdades
        // (t.ex. kunden borttagen, se syncCompanyLinks) — ett nytt token
        // för en kundkoppling som inte längre finns vore meningslöst och
        // skulle ändå avvisas av verifyAccessToken på nästa anrop.
        throw new Forbidden("Kontot är inte längre kopplat till det här företaget");
      }

      const newRefresh = await sql.begin(async (tx) => {
        // Rotationen är atomär: markera förbrukat OCH utfärda nytt i samma
        // transaktion. markTokenUsed 0 rader = en parallell /refresh hann
        // först — behandla som återanvändning och avsluta alla sessioner.
        if ((await repo.markTokenUsed(tx, row.id)) === 0) {
          await repo.revokeTokens(tx, row.user_id, "refresh");
          throw new Unauthorized("Token återanvänt — alla sessioner avslutade");
        }
        return issueTokenRow(user.id, row.tenant_id, "refresh", config.refreshTtlSeconds, tx);
      });
      const accessToken = await signAccessToken(
        {
          userId: user.id,
          tenantId: row.tenant_id,
          role: user.role,
          ...(customerId != null ? { customerId } : {}),
        },
        config.jwtUserSecret,
      );
      return toTokenPairResponse({
        accessToken,
        refreshToken: newRefresh,
        expiresIn: USER_TOKEN.ttlSeconds,
      });
    },

    async logout(refreshToken: string) {
      const row = await repo.findToken(hashToken(refreshToken, config.tokenPepper), "refresh");
      if (row && !row.used_at) {
        await repo.markTokenUsed(sql, row.id);
      }
      return OK;
    },

    async forgotPassword(rawEmail: string, correlationId?: string) {
      const email = norm(rawEmail);
      const user = await repo.findUserByEmailForLogin(email);
      // Gör alltid samma arbete (en hashning) så svarstiden inte skvallrar.
      await hashPassword(randomUUID());

      if (user) {
        await sql.begin(async (tx) => {
          await repo.revokeTokens(tx, user.id, "password_reset");
          await issueTokenRow(
            user.id,
            user.tenant_id,
            "password_reset",
            config.passwordResetTtlSeconds,
            tx,
          );
          await writeAuditLog(tx, {
            tenantId: user.tenant_id,
            actorUserId: user.id,
            action: "password.reset_requested",
            resourceType: "user",
            resourceId: String(user.id),
            correlationId,
          });
        });
      }
      return OK;
    },

    async resetPassword(token: string, newPassword: string, correlationId?: string) {
      const row = await repo.findToken(hashToken(token, config.tokenPepper), "password_reset");
      if (!row || row.used_at || row.expires_at.getTime() < Date.now()) {
        throw new BadRequest("Ogiltig eller utgången token");
      }
      const passwordHash = await hashPassword(newPassword);
      await sql.begin(async (tx) => {
        // 0 rader = en parallell reset hann konsumera länken först.
        if ((await repo.markTokenUsed(tx, row.id)) === 0) {
          throw new BadRequest("Ogiltig eller utgången token");
        }
        await repo.updatePassword(tx, row.user_id, passwordHash);
        // Lösenordsbyte ogiltigförklarar alla sessioner och andra
        // återställningslänkar (planens fas 1-beskrivning).
        await repo.revokeTokens(tx, row.user_id, "refresh");
        await repo.revokeTokens(tx, row.user_id, "password_reset");
        await writeAuditLog(tx, {
          tenantId: row.tenant_id,
          actorUserId: row.user_id,
          action: "password.reset",
          resourceType: "user",
          resourceId: String(row.user_id),
          correlationId,
        });
      });
      return OK;
    },

    /** Dev-only: utfärdar och RETURNERAR en färsk token i klartext, som
     *  ersättning för mejlet som documents skickar först i fas 4. */
    async issueDevToken(rawEmail: string, type: Exclude<TokenType, "refresh">) {
      if (!config.devEndpointsEnabled) {
        throw new NotFound("Not found");
      }
      const email = norm(rawEmail);
      const user = await repo.findUserByEmailAnyMethod(email);
      if (!user) throw new NotFound("Ingen användare med den e-posten");
      const token = await issueTokenRow(user.id, user.tenant_id, type, ttlFor(type));
      return { token };
    },

    /**
     * Fas 9 — admin-only (route-guardad, se guards.ts). Skapar (eller, om
     * kunden redan bjudits in men aldrig fullföljt, förnyar) en
     * kundportal-inloggning. customerId valideras mot billing S2S INNAN
     * någon rad skrivs — annars kunde en admin gissa sig till ett
     * customerId hos en annan tenant.
     */
    async createCustomerInvite(ctx: RequestContext, input: CreateCustomerInviteInput) {
      const customer = await findCustomer(redis, ctx.tenantId, input.customerId, ctx.correlationId);
      if (!customer) throw new NotFound("Kunden finns inte");
      const email = norm(input.email);

      const existing = await repo.findUserByCustomerId(input.customerId);
      if (existing) {
        // email_verified_at sätts av accept-customer-invite (precis som
        // verify-email för admins) — det ÄR "har fullföljt invite"-flaggan,
        // ingen egen kolumn behövs.
        if (existing.email_verified_at) {
          throw new Conflict("Kunden har redan portal-åtkomst");
        }
        try {
          await sql.begin(async (tx) => {
            await repo.revokeTokens(tx, existing.id, "customer_invite");
            // E-posten kan ha rättats sedan förra (ej fullföljda) inbjudan —
            // skriv den FÄRSKA adressen så länken går till rätt mottagare
            // (kodgranskning fas 9, fynd 4).
            await repo.updateEmail(tx, existing.id, email);
            await issueTokenRow(
              existing.id,
              ctx.tenantId,
              "customer_invite",
              config.customerInviteTtlSeconds,
              tx,
            );
            await writeAuditLog(tx, {
              tenantId: ctx.tenantId,
              actorUserId: ctx.userId,
              action: "customer.invite_resent",
              resourceType: "user",
              resourceId: String(existing.id),
              correlationId: ctx.correlationId,
            });
          });
        } catch (error) {
          // 23505 = unique_violation — users_email_unique är GLOBAL (0002_auth.js),
          // så den nya adressen kan redan tillhöra ett annat konto (en admin i
          // en annan tenant, eller en redan inbjuden kund). Ett tydligt 409 i
          // stället för att låta det bli ett okänt fel -> 500 (kodgranskning
          // fas 9, fynd 3).
          if ((error as { code?: string }).code === "23505") {
            throw new Conflict("E-postadressen används redan av ett annat konto");
          }
          throw error;
        }
        return OK;
      }

      // Slumpmässig, okänd placeholder — se repository.ts:s kommentar.
      const passwordHash = await hashPassword(randomUUID());
      try {
        await sql.begin(async (tx) => {
          const { id: userId } = await repo.insertCustomerInviteUser(tx, {
            tenantId: ctx.tenantId,
            customerId: input.customerId,
            email,
            passwordHash,
          });
          await issueTokenRow(
            userId,
            ctx.tenantId,
            "customer_invite",
            config.customerInviteTtlSeconds,
            tx,
          );
          await writeAuditLog(tx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            action: "customer.invited",
            resourceType: "user",
            resourceId: String(userId),
            correlationId: ctx.correlationId,
          });
        });
      } catch (error) {
        // Samma 23505-fall som ovan, för en HELT NY inbjudan.
        if ((error as { code?: string }).code === "23505") {
          throw new Conflict("E-postadressen används redan av ett annat konto");
        }
        throw error;
      }
      return OK;
    },

    /** Publik, engångslänk. Sätter lösenordet och markerar e-posten
     *  verifierad — precis som verify-email, fast i samma steg som
     *  lösenordet sätts (kunden bevisar redan att den äger länken). */
    async acceptCustomerInvite(input: AcceptCustomerInviteInput, correlationId?: string) {
      const row = await repo.findToken(
        hashToken(input.token, config.tokenPepper),
        "customer_invite",
      );
      if (!row || row.used_at || row.expires_at.getTime() < Date.now()) {
        throw new BadRequest("Ogiltig eller utgången inbjudningslänk");
      }
      const passwordHash = await hashPassword(input.password);
      await sql.begin(async (tx) => {
        if ((await repo.markTokenUsed(tx, row.id)) === 0) {
          throw new BadRequest("Ogiltig eller utgången inbjudningslänk");
        }
        await repo.updatePassword(tx, row.user_id, passwordHash);
        await repo.setEmailVerified(tx, row.user_id);
        await writeAuditLog(tx, {
          tenantId: row.tenant_id,
          actorUserId: row.user_id,
          action: "customer.invite_accepted",
          resourceType: "user",
          resourceId: String(row.user_id),
          correlationId,
        });
      });
      return OK;
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
