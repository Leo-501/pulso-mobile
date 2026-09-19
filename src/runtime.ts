import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import {
  mobileScope,
  type MobileSession,
  type MobileUser,
  type PullResponse,
} from '@pulso/contracts/mobile';
import {
  OfflineStore,
  SyncEngine,
  SyncError,
  type SqlDatabase,
  type SqlExecutor,
} from '@pulso/contracts/offline';

const SESSION_KEY = 'pulso.session.v1';
const DEVICE_KEY = 'pulso.device.v1';
const secureOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
export type SavedSession = MobileSession & { origin: string };

export function apiOrigin(input: string) {
  const url = new URL(input.trim());
  const local =
    /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(
      url.hostname,
    );
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Informe apenas o endereço do servidor, sem caminho, usuário ou parâmetros.');
  if (url.protocol !== 'https:' && !(__DEV__ && url.protocol === 'http:' && local))
    throw new Error(
      'Use um servidor HTTPS. HTTP local é permitido apenas no build de desenvolvimento.',
    );
  return url.origin;
}
export async function http<T>(
  origin: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    let response: Response;
    try {
      response = await fetch(origin + '/api/mobile' + path, {
        method: 'POST',
        signal: controller.signal,
        credentials: 'omit',
        headers: {
          'Content-Type': 'application/json',
          'x-cmms-request': '1',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new SyncError('Sem conexão com o servidor. As alterações salvas continuam na fila.', 0);
    }
    const data = await response.json().catch(() => null);
    if (!response.ok)
      throw new SyncError(
        data?.message ?? 'Não foi possível concluir a operação.',
        response.status,
      );
    if (!data) throw new SyncError('Resposta inválida. A operação será consultada novamente.', 0);
    return data as T;
  } finally {
    clearTimeout(timeout);
  }
}
export async function savedSession() {
  const raw = await SecureStore.getItemAsync(SESSION_KEY);
  return raw ? (JSON.parse(raw) as SavedSession) : null;
}
export function saveSession(session: SavedSession) {
  return SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session), secureOptions);
}
export async function signIn(
  originInput: string,
  company: string,
  email: string,
  password: string,
) {
  const origin = apiOrigin(originInput);
  let device = await SecureStore.getItemAsync(DEVICE_KEY);
  if (!device) {
    device = Crypto.randomUUID();
    await SecureStore.setItemAsync(DEVICE_KEY, device, secureOptions);
  }
  const result = await http<MobileSession>(origin, '/login', {
    company,
    email,
    password,
    device_id: device,
  });
  const session: SavedSession = { ...result, origin };
  return session;
}

function executor(db: SQLite.SQLiteDatabase): SqlExecutor {
  return {
    async run(sql, params = []) {
      await db.runAsync(sql, params);
    },
    all<T>(sql: string, params = []) {
      return db.getAllAsync<T>(sql, params);
    },
  };
}
export async function openRuntime(session: SavedSession) {
  const scope = mobileScope(session.user);
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    session.origin + ':' + scope,
  );
  const keyName = 'pulso.db.' + digest;
  let key = await SecureStore.getItemAsync(keyName);
  if (!key) {
    key = Array.from(await Crypto.getRandomBytesAsync(32))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    await SecureStore.setItemAsync(keyName, key, secureOptions);
  }
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('A chave do banco local não está disponível.');
  const db = await SQLite.openDatabaseAsync('pulso-' + digest + '.db');
  try {
    await db.execAsync(`PRAGMA key = '${key}';`);
    const cipher = await db.getFirstAsync<Record<string, string>>('PRAGMA cipher_version');
    if (!cipher || !Object.values(cipher).some(Boolean))
      throw new Error(
        'Este aplicativo exige um build Android com SQLCipher. O Expo Go não oferece o banco criptografado.',
      );
    await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    const adapter: SqlDatabase = {
      ...executor(db),
      exec: (sql) => db.execAsync(sql),
      async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>) {
        let result!: T;
        await db.withExclusiveTransactionAsync(async (tx) => {
          result = await fn(executor(tx));
        });
        return result;
      },
    };
    const store = await new OfflineStore(adapter, scope).init();
    const runtime = {
      session,
      store,
      engine: undefined as unknown as SyncEngine,
      async close() {
        await db.closeAsync();
      },
      async logout() {
        await http(session.origin, '/logout', {}, session.token);
      },
      async invalidate() {
        try {
          await SecureStore.deleteItemAsync(SESSION_KEY);
        } finally {
          await store.lockCache();
        }
      },
    };
    runtime.engine = new SyncEngine(store, {
      async pull(known) {
        const result = await http<PullResponse>(session.origin, '/pull', { known }, session.token);
        if (result.scope !== scope) throw new SyncError('A resposta pertence a outra conta.', 401);
        if (result.user.role !== session.user.role)
          throw new SyncError(
            'Seu perfil de acesso mudou. Entre novamente para atualizar os dados.',
            401,
          );
        runtime.session = { ...runtime.session, user: result.user as MobileUser };
        await saveSession(runtime.session);
        return result;
      },
      send: (operation) => http(session.origin, '/operations', operation, session.token),
    });
    return runtime;
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}
export type MobileRuntime = Awaited<ReturnType<typeof openRuntime>>;
