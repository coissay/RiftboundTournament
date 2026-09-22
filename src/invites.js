// Invitation d'un joueur sans compte, hors tournoi (free play…). Le pendant côté
// tournoi vit dans routes/tournaments.js (`sendInvite`) et enregistre en plus le
// tournoi d'origine ; ici on ne touche qu'au jeton et à la date d'envoi.
import { newInviteToken } from './guests.js';
import { sendMail, inviteMail, absoluteUrl } from './mailer.js';

// Lien de réclamation du compte invité (/register?invite=<jeton>).
export function inviteLink(req, token) {
  return absoluteUrl(req, `/register?invite=${encodeURIComponent(token)}`);
}

// Envoie (ou journalise, sans SMTP) l'invitation à `guest` de la part de l'utilisateur
// connecté. `context` : libellé de la partie, ex. « une partie libre (free play) ».
// Renvoie { sent, link } ; le lien est à afficher à l'inviteur quand `sent` est faux.
export async function sendGuestInvite(req, guest, { context } = {}) {
  const token = guest.invite?.token || newInviteToken();
  const link = inviteLink(req, token);
  const mail = inviteMail({ guestName: guest.username, context, organizerName: req.session.user.username, link });
  const { sent } = await sendMail({ to: guest.email, ...mail });
  await req.db.collection('users').updateOne(
    { _id: guest._id },
    { $set: { 'invite.token': token, 'invite.sentAt': sent ? new Date() : guest.invite?.sentAt || null } }
  );
  return { sent, link };
}
