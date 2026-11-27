// email.send: command on merkaly.signals (routing key = type); producers and signals share this contract
export const EMAIL_SEND = 'email.send';

export const EMAIL_SURFACES = ['admin', 'store', 'auth'] as const; // admin: to the merchant; store: to the buyer; auth: account emails

export type EmailSurface = (typeof EMAIL_SURFACES)[number];

export type EmailRecipient = string | { email: string; name?: string };

export interface EmailAction {
  label: string; // button text
  url: string; // https only
}

export interface EmailContent {
  title?: string; // top of the layout, fromName when missing
  text: string; // plain text body, escaped into the layout
  action?: EmailAction; // optional button under the text
}

// data of email.send; the idempotency key and organization travel in the MerkalyEvent envelope
export interface EmailSendData {
  surface: EmailSurface; // picks the from address configured in signals
  fromName?: string; // display name, Merkaly when missing
  to: EmailRecipient | EmailRecipient[];
  subject: string; // inbox line
  content: EmailContent;
}
