# Riftbound Tournois 🏆

Outil interne pour organiser des mini-tournois **Riftbound** en rondes suisses entre collègues, façon [locator UVS](https://locator.riftbound.uvsgames.com/).

## Lancer l'outil

Tout tourne dans Docker (app + MongoDB) :

```bash
docker compose up -d --build   # → http://localhost:3000
```

Les deux conteneurs redémarrent automatiquement au reboot de la machine (`restart: unless-stopped`). Pour que les collègues y accèdent depuis le réseau interne : `http://<ip-de-la-machine>:3000`.

Après une modification du code : `docker compose up -d --build` pour reconstruire.

### Dev hors Docker (optionnel)

```bash
docker compose up -d mongo   # seulement la base
npm install
npm run dev                  # relance auto à chaque modif → http://localhost:3000
```
(arrête d'abord le conteneur app s'il tourne : `docker compose stop app`, sinon le port 3000 est pris)

## Fonctionnalités

- **Comptes joueurs** : chacun crée son compte (pseudo + mot de passe).
- **Decks** : chaque joueur enregistre ses decks en collant simplement l'**export texte Riftbound** (sections `Legend:` / `Champion:` / `MainDeck:` / `Battlefields:` / `Runes:` / `Sideboard:`, lignes `3 Nom de la carte`). Légende, champion, domaines et champs de bataille sont déduits automatiquement ; les cartes sont reconnues via le **catalogue officiel** (l'API qui alimente la [galerie playriftbound.com](https://playriftbound.com/fr-fr/card-gallery/)) et le deck s'affiche **visuellement, avec les images des cartes**, dans un panneau latéral pendant la saisie puis sur la page du deck (`/decks/:id`). On s'inscrit à un tournoi **avec un deck précis**.
- **Deckbuilder** (`/deckbuilder`) : construction visuelle d'un deck façon [Piltover Archive](https://piltoverarchive.com/deckbuilder) — galerie du catalogue filtrable (recherche tolérante aux accents/apostrophes, domaines, type, extension, coût, tri), clic gauche pour ajouter / clic droit pour retirer, boutons ★ (champion) et R (réserve). Panneau latéral par sections (Légende / Champion / Deck principal / Champs de bataille / Runes / Réserve) avec compteurs et rappels des règles (1 légende, 1 champion, 40 cartes champion inclus, 3 champs de bataille, 12 runes, max 3 exemplaires, domaines de la légende) en vert/orange sans jamais bloquer. Le brouillon est conservé dans le navigateur (localStorage). Export texte au format decklist (copier, ou « Enregistrer comme deck » qui préremplit le formulaire), import d'une decklist collée, et « Ouvrir dans le deckbuilder » depuis un deck existant pour le modifier puis le mettre à jour.
- **Tournois** : durée variable (2h, 3h, 1 journée, 2 journées…), rondes de 50 min par défaut (modifiable), format de match **Bo1 / Bo3 / Bo5**. Le créateur du tournoi est l'organisateur.
- **Rondes suisses** :
  - Ronde 1 aléatoire, puis appariement par points (3 victoire / 1 nul / 0 défaite) ;
  - pas de rematch (sauf impossibilité totale) ;
  - **bye** automatique si nombre impair (victoire offerte, jamais deux fois au même joueur) ;
  - nombre de rondes conseillé calculé selon la durée et le nombre d'inscrits, mais l'organisateur garde la main (bouton « Ronde suivante » / « Clôturer »).
- **Timer** : compte à rebours de la ronde en cours affiché sur la page du tournoi (orange < 10 min, rouge clignotant une fois le temps écoulé → match nul si besoin).
- **Page match façon locator** : dans la ronde en cours, cliquer sur son versus ouvre la page du match — joueur 1 à gauche, joueur 2 à droite, score au centre, et **3 boutons par manche (Victoire J1 / Nul / Victoire J2)**. Chaque clic enregistre une manche ; la saisie se ferme dès que le match est décidé (2 manches gagnées en Bo3) ou que toutes les manches sont jouées, avec un bouton « Réinitialiser » pour corriger. Saisie par les joueurs de la table ou l'organisateur. Le résultat du match est recalculé à chaque manche : au temps, le score en l'état compte (plus de manches gagnées = victoire, égalité = nul). Le détail des manches s'affiche en pastilles dans les pairings.
- **Classement façon locator** : points, V-N-D, manches, puis tiebreakers dans l'ordre **OMW%** (win rate matchs des adversaires), **GW%** (% de manches gagnées), **OGW%** (% de manches gagnées des adversaires) — plancher 33 %, byes exclus des calculs adverses, bye compté comme victoire sur le score maximal (ex : 2-0 en Bo3).
- **La coupe** 🏆 : à la clôture, le 1er du classement remporte la coupe, affichée sur la page du tournoi et cumulée dans les stats.
- **Clôture automatique** : un tournoi non terminé sans activité depuis 7 jours (`AUTO_CLOSE_DAYS`) — ni date prévue, ni nouvelle ronde, ni réouverture plus récente — est clôturé automatiquement, **sans coupe**, et signalé comme tel. L'organisateur ou un **admin** (`ADMIN_USERS`) peut le **rouvrir** depuis le bloc « Organisation » : il reprend en cours s'il avait des rondes, sinon en inscriptions. La réouverture marche aussi pour une clôture manuelle (la coupe est alors retirée jusqu'à la prochaine clôture). Les admins ont les droits de l'organisateur sur tous les tournois.
- **Pairings façon locator** : record V-N-D affiché à côté de chaque joueur dans les rondes.
- **Stats** (`/stats`) : win rate et GW% par **joueur** et par **deck**, tous tournois confondus (byes exclus, nul = ½ victoire), avec le compteur de coupes.
- **Pages joueur** (`/players/:id`, accessibles en cliquant un nom) : palmarès, win rate matchs/manches, et historique complet des matchs (tournoi, ronde, decks, score, résultat).
- **Résultats officiels (locator UVS)** : page `/locator` pour lier son compte [locator.riftbound.uvsgames.com](https://locator.riftbound.uvsgames.com/) — soit email + mot de passe UVS (échangés contre un jeton, stocké chiffré ; le mot de passe n'est jamais conservé — les comptes « Sign in with Google » définissent d'abord un mot de passe via « Forgot your password? »), soit un cookie `sessionid` collé à la main. Le bouton « Importer mes résultats » récupère l'historique des événements officiels (rondes, adversaires, scores, deck joué) via l'API non documentée du locator (`api.riftbound.uvsgames.com`, celle qu'utilise le site), les stocke dans `external_events` et les affiche sur la page joueur avec bilan global, bilan par deck (rapprochement automatique avec les decks de l'outil par légende ou nom, corrigible à la main) et détail ronde par ronde.

## Stack

- Node.js + Express, vues EJS rendues serveur
- MongoDB 7 — collections `users`, `decks`, `tournaments` (rondes et matchs embarqués), `cards_catalog` (cache du catalogue de cartes), `external_events` (résultats importés du locator)
- Catalogue de cartes : chargé au démarrage depuis `content.publishing.riotgames.com` (~1200 cartes, images sur le CDN Riot), mis en cache en Mongo et rafraîchi toutes les 24 h. Sans réseau, l'app démarre avec le cache.
- Sessions persistées en Mongo (`connect-mongo`), mots de passe hashés (bcrypt)
- Docker Compose : service `app` (image Node construite via le `Dockerfile`) + service `mongo` (avec healthcheck — l'app attend que la base soit prête). Les données vivent dans le volume `mongo-data`.

## Structure

```
src/
  server.js        # app Express, sessions, montage des routes
  db.js            # connexion MongoDB + index
  swiss.js         # appariement suisse, classement, tiebreakers
  housekeeping.js  # clôture automatique des tournois en attente (passe horaire)
  cards.js         # catalogue de cartes (API galerie Riftbound) + parseur de decklist
  locator.js       # client API locator UVS (login, historique) + chiffrement du jeton + catalogue allégé pour le client
  routes/          # auth, decks, deckbuilder (/deckbuilder, /api/cards, /api/decklist/resolve), tournaments, stats, players
  views/           # pages EJS (deckbuilder.ejs pour le deckbuilder)
  public/          # style.css, timer.js, deck-preview.js, deckbuilder.js + deckbuilder.css (galerie/deck côté client)
```

## Remettre la base à zéro

```bash
docker exec riftbound-mongo mongosh riftbound --eval 'db.dropDatabase()'
# ou tout supprimer, volume compris :
docker compose down -v
```

## Variables d'environnement (optionnel)

- `LOCATOR_API` (défaut `https://api.riftbound.uvsgames.com`)
- `ADMIN_USERS` (pseudos séparés par des virgules : droits d'organisateur sur tous les tournois), `AUTO_CLOSE_DAYS` (défaut 7)
- `PORT` (défaut 3000), `MONGO_URL` (défaut `mongodb://localhost:27017`), `DB_NAME` (défaut `riftbound`), `SESSION_SECRET`, `CARDS_LOCALE` (défaut `en_US` — les noms des decklists exportées sont en anglais)
