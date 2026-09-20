import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Crypto from 'expo-crypto';
import { rotulosPrioridade, rotulosSituacao } from '@pulso/contracts';
import {
  identificadorQr,
  type RegistroLocal,
  type AtivoAplicativo,
  type OrdemAplicativo,
  type OperacaoAplicativo,
} from '@pulso/contracts/mobile';
import { ErroSincronizacao, type ItemFila } from '@pulso/contracts/offline';
import {
  abrirAmbiente,
  sessaoSalva,
  salvarSessao,
  entrar,
  type AmbienteAplicativo,
  type SessaoSalva,
} from './ambiente';

type Tela = 'ordens' | 'ativos' | 'fila';
type Respostas = Record<string, 'ok' | 'nok' | 'na'>;
const textoDoErro = (error: unknown) =>
  error instanceof Error ? error.message : 'Não foi possível concluir. Tente novamente.';
function Button({
  titulo,
  onPress,
  disabled = false,
  secondary = false,
}: {
  titulo: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={titulo}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondaryButton,
        (disabled || pressed) && { opacity: 0.55 },
      ]}
    >
      <Text style={[styles.buttonText, secondary && { color: '#143D35' }]}>{titulo}</Text>
    </Pressable>
  );
}
function Field({
  rotulo,
  value,
  onChange,
  secure = false,
  multiline = false,
  placeholder = '',
}: {
  rotulo: string;
  value: string;
  onChange: (value: string) => void;
  secure?: boolean;
  multiline?: boolean;
  placeholder?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.rotulo}>{rotulo}</Text>
      <TextInput
        accessibilityLabel={rotulo}
        value={value}
        onChangeText={onChange}
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
        multiline={multiline}
        placeholder={placeholder}
        placeholderTextColor="#707D78"
        style={[styles.input, multiline && { minHeight: 120, textAlignVertical: 'top' }]}
      />
    </View>
  );
}

function Login({
  enter,
  message,
}: {
  enter: (sessao: SessaoSalva) => Promise<void>;
  message: string;
}) {
  const [origem, setOrigem] = useState(__DEV__ ? 'http://10.0.2.2:3333' : '');
  const [empresa, setEmpresa] = useState(__DEV__ ? 'aurora' : '');
  const [email, setEmail] = useState(__DEV__ ? 'tecnico@demo.local' : '');
  const [senha, setSenha] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit() {
    setBusy(true);
    setError('');
    try {
      const sessao = await entrar(origem, empresa, email, senha);
      setSenha('');
      await enter(sessao);
    } catch (e) {
      setError(textoDoErro(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ScrollView contentContainerStyle={styles.login} keyboardShouldPersistTaps="handled">
      <Text style={styles.wordmark}>
        pulso<Text style={{ color: '#9AD055' }}>.</Text>
      </Text>
      <Text style={styles.eyebrow}>MANUTENÇÃO NO CHÃO DE FÁBRICA</Text>
      <Text style={styles.hero}>Seu trabalho,{'\n'}sempre à mão.</Text>
      <Text style={styles.muted}>
        Entre com conexão para baixar os dados da sua unidade. A consulta e os registros salvos
        ficam disponíveis durante a sessão de 8 horas.
      </Text>
      {!!(error || message) && (
        <Text accessibilityRole="alert" style={styles.warning}>
          {error || message}
        </Text>
      )}
      <Field
        rotulo="Servidor da empresa"
        value={origem}
        onChange={setOrigem}
        placeholder="https://manutencao.suaempresa.com"
      />
      <Field rotulo="Empresa" value={empresa} onChange={setEmpresa} />
      <Field rotulo="E-mail" value={email} onChange={setEmail} />
      <Field rotulo="Senha" value={senha} onChange={setSenha} secure />
      <Button
        titulo={busy ? 'Entrando…' : 'Entrar e preparar meu turno'}
        disabled={busy}
        onPress={() => void submit()}
      />
      {__DEV__ && <Text style={styles.caption}>Demonstração local · senha: Demo@2026!</Text>}
    </ScrollView>
  );
}

function Scanner({ onCode, close }: { onCode: (value: string) => void; close: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const seen = useRef(false);
  if (!permission?.granted)
    return (
      <View style={styles.content}>
        <Text style={styles.titulo}>Ler a etiqueta da máquina</Text>
        <Text style={styles.muted}>A câmera é usada apenas para identificar o QR Code.</Text>
        <Button
          titulo="Permitir acesso à câmera"
          onPress={() => {
            void requestPermission();
          }}
        />
        <Button titulo="Voltar e buscar pelo código" secondary onPress={close} />
      </View>
    );
  return (
    <View style={{ flex: 1 }}>
      <CameraView
        style={{ flex: 1 }}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          if (!seen.current) {
            seen.current = true;
            onCode(data);
          }
        }}
      />
      <View style={styles.content}>
        <Text style={styles.muted}>
          Aponte para o QR Code. O ativo precisa ter sido baixado nesta unidade.
        </Text>
        <Button titulo="Voltar" secondary onPress={close} />
      </View>
    </View>
  );
}

function RequestForm({
  ativo,
  save,
  back,
}: {
  ativo: AtivoAplicativo;
  save: (operation: OperacaoAplicativo) => Promise<void>;
  back: () => void;
}) {
  const [titulo, setTitle] = useState(''),
    [descricao, setDescription] = useState('');
  const [parada, setStopped] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  // Reuse the same identity even if a local write succeeds but a UI refresh fails.
  const id = useRef(Crypto.randomUUID());
  const observed = useRef<string | null>(null);
  async function submit() {
    setBusy(true);
    setError('');
    observed.current ??= new Date().toISOString();
    try {
      await save({
        id: id.current,
        tipo: 'solicitacao.criar',
        corpo: {
          ativo_id: ativo.id,
          titulo,
          descricao,
          maquina_parada: parada,
          observado_em: observed.current,
        },
      });
      back();
    } catch (e) {
      setError(textoDoErro(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Button titulo="Voltar aos ativos" secondary onPress={back} disabled={busy} />
      <Text style={styles.eyebrow}>
        {ativo.codigo} · {ativo.local}
      </Text>
      <Text style={styles.titulo}>Relatar um problema</Text>
      <Text style={styles.muted}>{ativo.nome}</Text>
      <Field rotulo="O que aconteceu?" value={titulo} onChange={setTitle} />
      <Field
        rotulo="Detalhes para a manutenção"
        value={descricao}
        onChange={setDescription}
        multiline
      />
      <View style={styles.row}>
        <Text style={[styles.rotulo, { flex: 1 }]}>A máquina está parada</Text>
        <Switch
          accessibilityLabel="A máquina está parada"
          value={parada}
          onValueChange={setStopped}
        />
      </View>
      <Text style={styles.caption}>
        A ocorrência será registrada com o horário do envio à fila. O chamado só chega ao gestor
        quando o servidor confirmar.
      </Text>
      {!!error && (
        <Text accessibilityRole="alert" style={styles.warning}>
          {error}
        </Text>
      )}
      <Button
        titulo={busy ? 'Salvando…' : 'Salvar solicitação no aparelho'}
        onPress={() => void submit()}
        disabled={busy}
      />
    </ScrollView>
  );
}

function OrderDetail({
  ordem,
  ativo,
  queued,
  save,
  back,
}: {
  ordem: OrdemAplicativo;
  ativo?: AtivoAplicativo;
  queued: boolean;
  save: (operation: OperacaoAplicativo) => Promise<void>;
  back: () => void;
}) {
  const [respostas, setRespostas] = useState<Respostas>(() =>
    Object.fromEntries(ordem.checklist.filter((i) => i.resposta).map((i) => [i.id, i.resposta!])),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const id = useRef(Crypto.randomUUID());
  const editable = ['in_progress', 'paused'].includes(ordem.situacao) && !queued;
  async function submit() {
    setBusy(true);
    setError('');
    try {
      await save({
        id: id.current,
        tipo: 'ordem.checklist',
        ordem_id: ordem.id,
        corpo: { versao: ordem.versao, respostas },
      });
      back();
    } catch (e) {
      setError(textoDoErro(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Button titulo="Voltar às minhas OS" secondary onPress={back} disabled={busy} />
      <Text style={styles.eyebrow}>
        OS {ordem.numero} · {rotulosSituacao[ordem.situacao]}
      </Text>
      <Text style={styles.titulo}>{ordem.titulo}</Text>
      <Text style={styles.muted}>
        {ativo?.codigo} · {ativo?.nome}
      </Text>
      <Text style={styles.corpo}>{ordem.descricao || 'Sem observações adicionais.'}</Text>
      <Text style={styles.caption}>
        Prazo: {ordem.prazo.split('-').reverse().join('/')} · Prioridade{' '}
        {rotulosPrioridade[ordem.prioridade]}
      </Text>
      <Text style={styles.sectionTitle}>Checklist de execução</Text>
      {queued && (
        <Text style={styles.warning}>
          Há respostas desta OS na fila. Sincronize ou revise o conflito antes de salvar novamente.
        </Text>
      )}
      {!editable && !queued && (
        <Text style={styles.caption}>
          O checklist é preenchido em OS em execução ou pausada. Início, pausa e conclusão continuam
          disponíveis no painel nesta etapa.
        </Text>
      )}
      {ordem.checklist.length === 0 && (
        <Text style={styles.muted}>Esta OS não possui checklist.</Text>
      )}
      {ordem.checklist.map((item, index) => (
        <View key={item.id} style={styles.card}>
          <Text style={styles.rotulo}>
            {index + 1}. {item.rotulo}
          </Text>
          <View style={styles.respostaRow}>
            {(['ok', 'nok', 'na'] as const).map((answer) => (
              <Pressable
                key={answer}
                accessibilityRole="radio"
                accessibilityState={{
                  checked: respostas[item.id] === answer,
                  disabled: !editable || busy,
                }}
                accessibilityLabel={`${item.rotulo}: ${answer === 'ok' ? 'OK' : answer === 'nok' ? 'Falha' : 'Não se aplica'}`}
                disabled={!editable || busy}
                onPress={() => setRespostas({ ...respostas, [item.id]: answer })}
                style={[styles.resposta, respostas[item.id] === answer && styles.respostaSelected]}
              >
                <Text style={styles.rotulo}>
                  {answer === 'ok' ? 'OK' : answer === 'nok' ? 'Falha' : 'N/A'}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ))}
      {!!error && (
        <Text accessibilityRole="alert" style={styles.warning}>
          {error}
        </Text>
      )}
      {editable && ordem.checklist.length > 0 && (
        <Button
          titulo={busy ? 'Salvando…' : 'Salvar respostas no aparelho'}
          onPress={() => void submit()}
          disabled={busy || Object.keys(respostas).length === 0}
        />
      )}
    </ScrollView>
  );
}

function QueueCard({
  item,
  ordem,
  reenviar,
  arquivar,
}: {
  item: ItemFila;
  ordem?: OrdemAplicativo;
  reenviar: () => void;
  arquivar: () => void;
}) {
  const op: OperacaoAplicativo = JSON.parse(item.corpo);
  const rotulos = {
    pendente: 'Aguardando envio',
    confirmada: 'Confirmado pelo servidor',
    conflito: 'Precisa de revisão',
    rejeitada: 'Envio recusado',
    substituida: 'Revisão registrada',
    arquivada: 'Arquivado neste aparelho',
  };
  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>{rotulos[item.situacao]}</Text>
      <Text style={styles.cardTitle}>
        {op.tipo === 'solicitacao.criar'
          ? op.corpo.titulo
          : `Checklist · OS ${ordem?.numero ?? op.ordem_id.slice(0, 8)}`}
      </Text>
      <Text style={styles.caption}>{new Date(item.criado_em).toLocaleString('pt-BR')}</Text>
      {op.tipo === 'solicitacao.criar' && <Text style={styles.corpo}>{op.corpo.descricao}</Text>}
      {item.erro && <Text style={styles.warning}>{item.erro}</Text>}
      {op.tipo === 'ordem.checklist' &&
        ['conflito', 'rejeitada', 'arquivada'].includes(item.situacao) && (
          <>
            <Text style={styles.rotulo}>Suas respostas preservadas</Text>
            {Object.entries(op.corpo.respostas).map(([key, value]) => (
              <Text key={key} style={styles.corpo}>
                {ordem?.checklist.find((i) => i.id === key)?.rotulo ?? key}: {value.toUpperCase()} ·
                servidor:{' '}
                {ordem?.checklist.find((i) => i.id === key)?.resposta?.toUpperCase() ??
                  'sem resposta'}
              </Text>
            ))}
            {item.situacao === 'conflito' && ordem && (
              <Button titulo="Revisar e reaplicar minhas respostas" secondary onPress={reenviar} />
            )}
          </>
        )}
      {item.situacao === 'rejeitada' && (
        <Text style={styles.caption}>
          Os dados foram preservados. Consulte o gestor para corrigir o acesso ou o registro.
        </Text>
      )}
      {['conflito', 'rejeitada'].includes(item.situacao) && (
        <Button titulo="Arquivar tentativa neste aparelho" secondary onPress={arquivar} />
      )}
    </View>
  );
}

function Main() {
  const [ambiente, setAmbiente] = useState<AmbienteAplicativo | null>(null),
    [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<RegistroLocal[]>([]),
    [fila, setFila] = useState<ItemFila[]>([]),
    [lastSync, setLastSync] = useState<string | null>(null);
  const [tela, setTela] = useState<Tela>('ordens'),
    [search, setSearch] = useState('');
  const [selectedOrder, setSelectedOrder] = useState<string | null>(null),
    [requestAsset, setRequestAsset] = useState<string | null>(null),
    [scanner, setScanner] = useState(false);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [connected, setConnected] = useState(false);
  const syncing = useRef(false),
    syncRef = useRef<() => void>(() => {});
  const ativos = records
    .filter((r) => r.entidade === 'ativo')
    .map((r) => r.dados as AtivoAplicativo);
  const ordens = records
    .filter((r) => r.entidade === 'ordem')
    .map((r) => r.dados as OrdemAplicativo);
  const pendencias = fila.filter((o) => ['pendente', 'conflito', 'rejeitada'].includes(o.situacao));
  async function refresh(rt: AmbienteAplicativo) {
    const [items, operations, time] = await Promise.all([
      rt.base.registros(),
      rt.base.fila(),
      rt.base.ultimaSincronizacao(),
    ]);
    setRecords(items);
    setFila(operations);
    setLastSync(time);
  }
  async function enter(sessao: SessaoSalva, fresh = false) {
    const rt = await abrirAmbiente(sessao);
    try {
      if (fresh) {
        await rt.base.bloquearCache();
        await salvarSessao(sessao);
      }
      await refresh(rt);
    } catch (error) {
      await rt.fechar();
      throw error;
    }
    setAmbiente(rt);
    setTela(sessao.pessoa.papel === 'solicitante' ? 'ativos' : 'ordens');
    setMessage('');
    setSelectedOrder(null);
    setRequestAsset(null);
  }
  useEffect(() => {
    void (async () => {
      try {
        const sessao = await sessaoSalva();
        if (sessao && Date.parse(sessao.expira_em) > Date.now()) await enter(sessao);
        else if (sessao)
          setMessage(
            'Sua sessão terminou. Conecte-se e entre novamente na mesma conta para recuperar a fila.',
          );
      } catch (e) {
        setMessage(textoDoErro(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);
  async function sync() {
    if (!ambiente || syncing.current) return;
    syncing.current = true;
    setBusy(true);
    try {
      if (Date.parse(ambiente.sessao.expira_em) <= Date.now())
        throw new ErroSincronizacao('Sua sessão terminou. Entre novamente para continuar.', 401);
      await ambiente.motor.sincronizar();
      await refresh(ambiente);
      setConnected(true);
      setMessage('');
    } catch (e) {
      setConnected(false);
      setMessage(textoDoErro(e));
      if (e instanceof ErroSincronizacao && e.status === 401) {
        setAmbiente(null);
        setRecords([]);
        setFila([]);
        setSelectedOrder(null);
        setRequestAsset(null);
        setScanner(false);
        try {
          await ambiente.invalidar();
        } catch {
          setMessage(
            'Acesso bloqueado. Não foi possível limpar o cache; entre novamente com conexão.',
          );
        } finally {
          await ambiente.fechar().catch(() => {});
        }
      } else {
        try {
          await refresh(ambiente);
        } catch (localError) {
          setMessage(textoDoErro(localError));
        }
      }
    } finally {
      syncing.current = false;
      setBusy(false);
    }
  }
  syncRef.current = () => {
    // Avoid replacing the downloaded version while the user is filling a form.
    if (ambiente && Date.parse(ambiente.sessao.expira_em) <= Date.now()) {
      void sync();
      return;
    }
    if (!selectedOrder && !requestAsset && !scanner) void sync();
  };
  useEffect(() => {
    if (!ambiente) return;
    syncRef.current();
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') syncRef.current();
    }, 30_000);
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') syncRef.current();
    });
    return () => {
      clearInterval(timer);
      listener.remove();
    };
  }, [ambiente]);
  async function save(operation: OperacaoAplicativo) {
    if (!ambiente || Date.parse(ambiente.sessao.expira_em) <= Date.now())
      throw new Error('Conecte-se e entre novamente antes de salvar.');
    await ambiente.base.enfileirar(operation);
    await refresh(ambiente);
    setMessage('Salvo neste aparelho. A confirmação aparecerá na fila após sincronizar.');
  }
  function onQr(value: string) {
    setScanner(false);
    const token = identificadorQr(value),
      ativo = ativos.find((item) => item.token_qr === token);
    if (!ativo) {
      Alert.alert(
        'Ativo não disponível',
        'Este QR não corresponde aos ativos baixados nesta unidade. Conecte-se e sincronize, ou busque pelo código.',
      );
      return;
    }
    setRequestAsset(ativo.id);
  }
  function reenviar(item: ItemFila) {
    Alert.alert(
      'Reaplicar respostas?',
      'Confira suas respostas e as respostas atuais exibidas na fila. Esta ação cria uma nova tentativa sobre a versão baixada e mantém o conflito original no histórico.',
      [
        { text: 'Voltar', style: 'cancel' },
        {
          text: 'Reaplicar',
          onPress: () => {
            void (async () => {
              try {
                await ambiente!.base.reaplicarChecklist(item.id, Crypto.randomUUID());
                await refresh(ambiente!);
              } catch (e) {
                Alert.alert('Revisão não aplicada', textoDoErro(e));
              }
            })();
          },
        },
      ],
    );
  }
  function arquivar(item: ItemFila) {
    Alert.alert(
      'Arquivar tentativa?',
      'Esta tentativa deixará as pendências. Os dados continuam no histórico deste aparelho; nenhum envio já recebido pelo servidor será desfeito.',
      [
        { text: 'Voltar', style: 'cancel' },
        {
          text: 'Arquivar',
          onPress: () => {
            void (async () => {
              try {
                await ambiente!.base.arquivar(item.id);
                await refresh(ambiente!);
              } catch (e) {
                Alert.alert('Não foi possível arquivar', textoDoErro(e));
              }
            })();
          },
        },
      ],
    );
  }
  async function logout() {
    if (!ambiente || busy) return;
    if (pendencias.length) {
      Alert.alert(
        'Há registros no aparelho',
        'Sincronize e revise as pendências antes de sair. Se o acesso mudou, os registros ficam protegidos para recuperação na mesma conta.',
      );
      return;
    }
    setBusy(true);
    try {
      await ambiente.sair();
      setAmbiente(null);
      setRecords([]);
      setFila([]);
      setMessage('');
      try {
        await ambiente.invalidar();
      } finally {
        await ambiente.fechar();
      }
    } catch (e) {
      setMessage(textoDoErro(e));
    } finally {
      setBusy(false);
    }
  }
  if (loading)
    return (
      <View style={styles.content}>
        <Text style={styles.titulo}>Preparando o aparelho…</Text>
      </View>
    );
  if (!ambiente) return <Login enter={(sessao) => enter(sessao, true)} message={message} />;
  const ordem = ordens.find((item) => item.id === selectedOrder),
    ativo = ativos.find((item) => item.id === requestAsset);
  if (scanner) return <Scanner onCode={onQr} close={() => setScanner(false)} />;
  if (ativo)
    return (
      <RequestForm key={ativo.id} ativo={ativo} save={save} back={() => setRequestAsset(null)} />
    );
  if (ordem)
    return (
      <OrderDetail
        key={ordem.id + ':' + ordem.versao}
        ordem={ordem}
        ativo={ativos.find((a) => a.id === ordem.ativo_id)}
        queued={pendencias.some((o) => o.ordem_id === ordem.id)}
        save={save}
        back={() => setSelectedOrder(null)}
      />
    );
  const filteredAssets = ativos.filter((item) =>
    `${item.codigo} ${item.nome} ${item.local}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.logo}>pulso.</Text>
          <Text style={styles.headerCaption}>{ambiente.sessao.pessoa.unidade_nome}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sair da conta"
          onPress={() => void logout()}
          disabled={busy}
          style={styles.signOut}
        >
          <Text style={{ color: '#ECF6EE' }}>Sair</Text>
        </Pressable>
      </View>
      <View style={styles.syncBar}>
        <Text style={styles.syncText}>
          {busy ? 'Sincronizando…' : connected ? 'Conectado ao servidor' : 'Dados neste aparelho'} ·{' '}
          {pendencias.length} pendente(s)
        </Text>
        <Pressable
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Sincronizar agora"
          onPress={() => void sync()}
          style={styles.syncButton}
        >
          <Text style={styles.rotulo}>Sincronizar</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {!!message && (
          <Text accessibilityRole="alert" style={styles.warning}>
            {message}
          </Text>
        )}
        <Text style={styles.eyebrow}>
          OLÁ, {ambiente.sessao.pessoa.nome.split(' ')[0].toUpperCase()}
        </Text>
        <Text style={styles.titulo}>
          {tela === 'ordens'
            ? 'Minhas ordens'
            : tela === 'ativos'
              ? 'Ativos da unidade'
              : 'Fila de sincronização'}
        </Text>
        <Text style={styles.caption}>
          {lastSync
            ? 'Última atualização: ' + new Date(lastSync).toLocaleString('pt-BR')
            : 'Sincronize com conexão para baixar os primeiros dados.'}
        </Text>
        {tela === 'ordens' && (
          <>
            <Text style={styles.muted}>
              Ordens atribuídas a você, prontas para consulta no chão de fábrica.
            </Text>
            {ordens.length === 0 && (
              <View style={styles.card}>
                <Text style={styles.corpo}>Nenhuma OS baixada para você.</Text>
              </View>
            )}
            {[...ordens]
              .sort((a, b) => a.prazo.localeCompare(b.prazo))
              .map((item) => (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Abrir OS ${item.numero}: ${item.titulo}`}
                  disabled={busy}
                  onPress={() => setSelectedOrder(item.id)}
                  style={styles.card}
                >
                  <View style={styles.row}>
                    <Text style={styles.eyebrow}>OS {item.numero}</Text>
                    <Text style={styles.pill}>{rotulosSituacao[item.situacao]}</Text>
                  </View>
                  <Text style={styles.cardTitle}>{item.titulo}</Text>
                  <Text style={styles.muted}>
                    {ativos.find((a) => a.id === item.ativo_id)?.codigo} ·{' '}
                    {rotulosPrioridade[item.prioridade]}
                  </Text>
                  <Text style={styles.caption}>
                    Prazo {item.prazo.split('-').reverse().join('/')}
                  </Text>
                </Pressable>
              ))}
          </>
        )}
        {tela === 'ativos' && (
          <>
            <Button
              titulo="Ler QR Code da máquina"
              onPress={() => setScanner(true)}
              disabled={!lastSync || busy}
            />
            <Field
              rotulo="Buscar ativo"
              value={search}
              onChange={setSearch}
              placeholder="Código, nome ou setor"
            />
            {filteredAssets.length === 0 && (
              <Text style={styles.muted}>Nenhum ativo encontrado nos dados baixados.</Text>
            )}
            {filteredAssets.map((item) => (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityLabel={`Abrir solicitação para ${item.codigo}`}
                disabled={busy}
                onPress={() => setRequestAsset(item.id)}
                style={styles.card}
              >
                <Text style={styles.eyebrow}>
                  {item.codigo} · {item.local}
                </Text>
                <Text style={styles.cardTitle}>{item.nome}</Text>
                <Text style={styles.link}>Relatar um problema →</Text>
              </Pressable>
            ))}
          </>
        )}
        {tela === 'fila' && (
          <>
            <Text style={styles.muted}>
              Os registros permanecem neste aparelho até a confirmação. Conflitos exigem revisão;
              suas respostas são preservadas.
            </Text>
            {fila.length === 0 && (
              <View style={styles.card}>
                <Text style={styles.corpo}>
                  Tudo em dia. Nenhuma operação registrada neste aparelho.
                </Text>
              </View>
            )}
            {[...fila].reverse().map((item) => (
              <QueueCard
                key={item.id}
                item={item}
                ordem={ordens.find((o) => o.id === item.ordem_id)}
                reenviar={() => reenviar(item)}
                arquivar={() => arquivar(item)}
              />
            ))}
          </>
        )}
      </ScrollView>
      <View accessibilityRole="tablist" style={styles.tabs}>
        {(
          [
            ['ordens', 'Minhas OS'],
            ['ativos', 'Ativos'],
            ['fila', `Fila (${pendencias.length})`],
          ] as const
        )
          .filter(([key]) => key !== 'ordens' || ambiente.sessao.pessoa.papel === 'tecnico')
          .map(([key, rotulo]) => (
            <Pressable
              key={key}
              accessibilityRole="tab"
              accessibilityState={{ selected: tela === key }}
              onPress={() => setTela(key)}
              style={[styles.tab, tela === key && styles.tabSelected]}
            >
              <Text style={styles.rotulo}>{rotulo}</Text>
            </Pressable>
          ))}
      </View>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe}>
        <Main />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F4F6F1' },
  content: { padding: 20, gap: 14, paddingBottom: 40 },
  login: { padding: 24, gap: 16, paddingTop: 40, paddingBottom: 48 },
  wordmark: { color: '#143D35', fontSize: 44, fontWeight: '800', letterSpacing: -2 },
  hero: { color: '#143D35', fontSize: 36, fontWeight: '700', lineHeight: 41, letterSpacing: -1 },
  eyebrow: { color: '#497064', fontSize: 12, fontWeight: '700', letterSpacing: 0.7 },
  titulo: { color: '#173E34', fontSize: 28, fontWeight: '700', lineHeight: 34 },
  sectionTitle: { color: '#173E34', fontSize: 20, fontWeight: '700', marginTop: 12 },
  muted: { color: '#52665C', fontSize: 15, lineHeight: 23 },
  caption: { color: '#52665C', fontSize: 12, lineHeight: 19 },
  corpo: { color: '#2A4035', fontSize: 16, lineHeight: 24 },
  field: { gap: 8 },
  rotulo: { color: '#173E34', fontSize: 15, fontWeight: '600' },
  input: {
    backgroundColor: '#FFFFFF',
    minHeight: 56,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: '#D2DED5',
    borderRadius: 12,
    color: '#173E34',
    fontSize: 16,
  },
  button: {
    backgroundColor: '#CBEB87',
    minHeight: 56,
    borderRadius: 12,
    padding: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonText: { color: '#163D32', fontSize: 16, fontWeight: '700', textAlign: 'center' },
  secondaryButton: { backgroundColor: '#E4EDE6', borderWidth: 1, borderColor: '#CFDBD1' },
  warning: {
    backgroundColor: '#FFF0D1',
    color: '#75511E',
    borderRadius: 10,
    padding: 14,
    fontSize: 14,
    lineHeight: 21,
  },
  card: {
    backgroundColor: '#FFFFFF',
    padding: 18,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DEE7DF',
    gap: 10,
  },
  cardTitle: { color: '#183D34', fontSize: 19, fontWeight: '700', lineHeight: 25 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  pill: {
    color: '#34614E',
    backgroundColor: '#EDF5E6',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    fontSize: 12,
  },
  link: { color: '#316C54', fontSize: 15, fontWeight: '600' },
  header: {
    backgroundColor: '#143D35',
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingVertical: 14,
    alignItems: 'center',
  },
  logo: { color: '#D4F094', fontSize: 28, fontWeight: '800', letterSpacing: -1 },
  headerCaption: { color: '#CCE1D5', fontSize: 12 },
  signOut: { minHeight: 56, minWidth: 56, justifyContent: 'center', alignItems: 'center' },
  syncBar: {
    backgroundColor: '#E5EDDF',
    paddingLeft: 20,
    paddingRight: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  syncText: { flex: 1, color: '#3D6049', fontSize: 12, lineHeight: 18 },
  syncButton: { minHeight: 56, justifyContent: 'center', paddingHorizontal: 12 },
  tabs: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    padding: 8,
    borderTopWidth: 1,
    borderTopColor: '#DAE4D8',
    gap: 6,
  },
  tab: { flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  tabSelected: { backgroundColor: '#E5F1D5' },
  respostaRow: { flexDirection: 'row', gap: 8 },
  resposta: {
    flex: 1,
    minHeight: 56,
    borderWidth: 1,
    borderColor: '#D4DFD0',
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  respostaSelected: { backgroundColor: '#D7EDAD', borderColor: '#638C40', borderWidth: 2 },
});
