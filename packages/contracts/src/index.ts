export {
  assertValidEnvelope,
  isValidEnvelope,
  EnvelopeValidationError,
  assertValidPayload,
  isValidPayload,
  payloadSchemaPath,
  PayloadValidationError,
} from "./validate";
export { loadSchema, loadFixture } from "./schema-loader";
export { DELIVERY_STATUS_ORDER, deliveryRank } from "./delivery-rank";
export type { EventEnvelope } from "./generated/envelope";
export type { InvoiceSentPayload } from "./generated/invoice-sent";
export type { InvoiceCreditedPayload } from "./generated/invoice-credited";
export type { InvoiceReminderSentPayload } from "./generated/invoice-reminder-sent";
export type { InvoiceDeliveryUpdatedPayload } from "./generated/invoice-delivery-updated";
export type { PaymentMatchedPayload } from "./generated/payment-matched";
export type { PaymentPartialPayload } from "./generated/payment-partial";

// REST-typer (fas 8, handskrivna — inget schema/codegen för dem ännu).
// Delas mellan backend-mapparna och apps/backoffice.
export type { UserRole, CurrentUserDto, CompanyLinkDto } from "./rest/auth";
export type { CompanyOverviewEntry, CompanyOverviewDto } from "./rest/company-overview";
export type {
  CustomerType,
  CustomerDto,
  CreateCustomerInput,
  UpdateCustomerInput,
} from "./rest/customers";
export type {
  InvoiceType,
  InvoiceStatus,
  DeliveryStatus,
  VatRate,
  InvoiceSummaryDto,
  InvoiceLineDto,
  InvoiceDetailDto,
  LineInputDto,
  CreateInvoiceInput,
  UpdateInvoiceInput,
  RecurrenceInterval,
  InvoiceTemplateSummaryDto,
  InvoiceTemplateDetailDto,
  CreateInvoiceTemplateInput,
  UpdateInvoiceTemplateInput,
} from "./rest/invoices";
export type { UnmatchedTransactionDto, MatchBody, IgnoreBody } from "./rest/payments";
export type {
  PortalInvoiceSummaryDto,
  PortalInvoiceLineDto,
  PortalInvoiceDetailDto,
  PortalInvoicePdfDto,
  PortalAccountSummaryDto,
  PortalInvoiceTemplateDto,
  PortalPaymentSessionDto,
  CreateCustomerInviteInput,
  AcceptCustomerInviteInput,
} from "./rest/portal";
