import { MongoClient, ObjectId } from 'mongodb';

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'riftbound';

const client = new MongoClient(MONGO_URL);

export async function connect() {
  await client.connect();
  const db = client.db(DB_NAME);
  await db.collection('users').createIndex({ username: 1 }, { unique: true });
  await db.collection('decks').createIndex({ ownerId: 1 });
  await db.collection('tournaments').createIndex({ date: -1 });
  await db.collection('tournaments').createIndex({ 'players.userId': 1 }); // page joueur
  // Un événement locator par (joueur, événement) : l'import fait un upsert dessus,
  // l'unicité empêche les doublons si deux imports se croisent.
  await db.collection('external_events').createIndex({ ownerId: 1, eventId: 1 }, { unique: true });
  await db.collection('external_events').createIndex({ ownerId: 1, date: -1 }); // page joueur, tri par date
  return db;
}

export function oid(id) {
  try {
    return new ObjectId(String(id));
  } catch {
    return null;
  }
}

export { MONGO_URL, DB_NAME };
