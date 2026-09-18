// Envoi d'e-mails (invitations des joueurs invités). SMTP configuré par SMTP_URL
// (ex. smtp://user:pass@smtp.exemple.fr:587) et MAIL_FROM. Sans SMTP, l'e-mail est
// écrit dans les logs et le lien d'invitation reste affiché à l'organisateur.
import nodemailer from 'nodemailer';

const SMTP_URL = process.env.SMTP_URL || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Riftbound Tournois <no-reply@riftbound.local>';
export const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');

const transport = SMTP_URL ? nodemailer.createTransport(SMTP_URL) : null;

export function mailConfigured() {
  return !!transport;
}

// URL absolue : BASE_URL si défini, sinon déduite de la requête.
export function absoluteUrl(req, path) {
  const base = BASE_URL || `${req.protocol}://${req.get('host')}`;
  return base + path;
}

export async function sendMail({ to, subject, text }) {
  if (!transport) {
    console.log(`[mail non envoyé — SMTP_URL absent] à ${to} — ${subject}\n${text}`);
    return { sent: false };
  }
  await transport.sendMail({ from: MAIL_FROM, to, subject, text });
  return { sent: true };
}

export function inviteMail({ guestName, tournamentName, organizerName, link }) {
  return {
    subject: `Riftbound Tournois — crée ton compte pour garder ton historique`,
    text: [
      `Salut ${guestName},`,
      ``,
      `${organizerName} t'a ajouté·e au tournoi « ${tournamentName} » sur l'outil interne Riftbound Tournois.`,
      `Tes matchs sont enregistrés à ton nom. Pour conserver ton historique (résultats, classement, stats)`,
      `et pouvoir indiquer le deck que tu as joué, crée ton compte avec ce lien :`,
      ``,
      link,
      ``,
      `Le lien est personnel : il rattache ton compte à tes tournois déjà joués.`,
      ``,
      `À bientôt autour d'une table !`,
    ].join('\n'),
  };
}
