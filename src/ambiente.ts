import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import {
  escopoAplicativo,
  type SessaoAplicativo,
  type PessoaAplicativo,
  type RespostaDownload,
} from '@pulso/contracts/mobile';
import {
  BaseLocal,
  MotorSincronizacao,
  ErroSincronizacao,
  type BancoSql,
  type ExecutorSql,
} from '@pulso/contracts/offline';

const CHAVE_SESSAO = 'pulso.session.v1';
const CHAVE_APARELHO = 'pulso.device.v1';
const opcoesSeguras = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
export type SessaoSalva = SessaoAplicativo & { origem: string };

export function origemDaApi(entrada: string) {
  const url = new URL(entrada.trim());
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
  origem: string,
  caminho: string,
  corpo: unknown,
  token?: string,
): Promise<T> {
  const controle = new AbortController();
  const prazo = setTimeout(() => controle.abort(), 15_000);
  try {
    let resposta: Response;
    try {
      resposta = await fetch(origem + '/api/aplicativo' + caminho, {
        method: 'POST',
        signal: controle.signal,
        credentials: 'omit',
        headers: {
          'Content-Type': 'application/json',
          'x-pulso-requisicao': '1',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        body: JSON.stringify(corpo),
      });
    } catch {
      throw new ErroSincronizacao(
        'Sem conexão com o servidor. As alterações salvas continuam na fila.',
        0,
      );
    }
    const dados = await resposta.json().catch(() => null);
    if (!resposta.ok)
      throw new ErroSincronizacao(
        dados?.mensagem ?? 'Não foi possível concluir a operação.',
        resposta.status,
      );
    if (!dados)
      throw new ErroSincronizacao('Resposta inválida. A operação será consultada novamente.', 0);
    return dados as T;
  } finally {
    clearTimeout(prazo);
  }
}
export async function sessaoSalva() {
  const bruto = await SecureStore.getItemAsync(CHAVE_SESSAO);
  return bruto ? (JSON.parse(bruto) as SessaoSalva) : null;
}
export function salvarSessao(sessao: SessaoSalva) {
  return SecureStore.setItemAsync(CHAVE_SESSAO, JSON.stringify(sessao), opcoesSeguras);
}
export async function entrar(
  origemInformada: string,
  empresa: string,
  email: string,
  senha: string,
) {
  const origem = origemDaApi(origemInformada);
  let aparelho = await SecureStore.getItemAsync(CHAVE_APARELHO);
  if (!aparelho) {
    aparelho = Crypto.randomUUID();
    await SecureStore.setItemAsync(CHAVE_APARELHO, aparelho, opcoesSeguras);
  }
  const resultado = await http<SessaoAplicativo>(origem, '/entrar', {
    empresa,
    email,
    senha,
    dispositivo_id: aparelho,
  });
  const sessao: SessaoSalva = { ...resultado, origem };
  return sessao;
}

function executor(db: SQLite.SQLiteDatabase): ExecutorSql {
  return {
    async executar(sql, parametros = []) {
      await db.runAsync(sql, parametros);
    },
    consultar<T>(sql: string, parametros = []) {
      return db.getAllAsync<T>(sql, parametros);
    },
  };
}
export async function abrirAmbiente(sessao: SessaoSalva) {
  const escopo = escopoAplicativo(sessao.pessoa);
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    sessao.origem + ':' + escopo,
  );
  const nomeChave = 'pulso.db.' + digest;
  let chave = await SecureStore.getItemAsync(nomeChave);
  if (!chave) {
    chave = Array.from(await Crypto.getRandomBytesAsync(32))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    await SecureStore.setItemAsync(nomeChave, chave, opcoesSeguras);
  }
  if (!/^[a-f0-9]{64}$/.test(chave)) throw new Error('A chave do banco local não está disponível.');
  const db = await SQLite.openDatabaseAsync('pulso-' + digest + '.db');
  try {
    await db.execAsync(`PRAGMA key = '${chave}';`);
    const cifra = await db.getFirstAsync<Record<string, string>>('PRAGMA cipher_version');
    if (!cifra || !Object.values(cifra).some(Boolean))
      throw new Error(
        'Este aplicativo exige um build Android com SQLCipher. O Expo Go não oferece o banco criptografado.',
      );
    await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    const adaptador: BancoSql = {
      ...executor(db),
      script: (sql) => db.execAsync(sql),
      async transacao<T>(fn: (tx: ExecutorSql) => Promise<T>) {
        let resultado!: T;
        await db.withExclusiveTransactionAsync(async (tx) => {
          resultado = await fn(executor(tx));
        });
        return resultado;
      },
    };
    const base = await new BaseLocal(adaptador, escopo).iniciar();
    const ambiente = {
      sessao,
      base,
      motor: undefined as unknown as MotorSincronizacao,
      async fechar() {
        await db.closeAsync();
      },
      async sair() {
        await http(sessao.origem, '/sair', {}, sessao.token);
      },
      async invalidar() {
        try {
          await SecureStore.deleteItemAsync(CHAVE_SESSAO);
        } finally {
          await base.bloquearCache();
        }
      },
    };
    ambiente.motor = new MotorSincronizacao(base, {
      async baixar(conhecidos) {
        const resultado = await http<RespostaDownload>(
          sessao.origem,
          '/baixar',
          { conhecidos },
          sessao.token,
        );
        if (resultado.escopo !== escopo)
          throw new ErroSincronizacao('A resposta pertence a outra conta.', 401);
        if (resultado.pessoa.papel !== sessao.pessoa.papel)
          throw new ErroSincronizacao(
            'Seu perfil de acesso mudou. Entre novamente para atualizar os dados.',
            401,
          );
        ambiente.sessao = { ...ambiente.sessao, pessoa: resultado.pessoa as PessoaAplicativo };
        await salvarSessao(ambiente.sessao);
        return resultado;
      },
      enviar: (operacao) => http(sessao.origem, '/operacoes', operacao, sessao.token),
    });
    return ambiente;
  } catch (erro) {
    await db.closeAsync();
    throw erro;
  }
}
export type AmbienteAplicativo = Awaited<ReturnType<typeof abrirAmbiente>>;
