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
import { priorityLabels, statusLabels } from '@pulso/contracts';
import {
  qrIdentifier,
  type CachedRecord,
  type MobileAsset,
  type MobileOrder,
  type MobileOperation,
} from '@pulso/contracts/mobile';
import { SyncError, type OutboxEntry } from '@pulso/contracts/offline';
import {
  openRuntime,
  savedSession,
  saveSession,
  signIn,
  type MobileRuntime,
  type SavedSession,
} from './runtime';

type Screen = 'orders' | 'assets' | 'queue';
type Answers = Record<string, 'ok' | 'nok' | 'na'>;
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Não foi possível concluir. Tente novamente.';
function Button({
  title,
  onPress,
  disabled = false,
  secondary = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondaryButton,
        (disabled || pressed) && { opacity: 0.55 },
      ]}
    >
      <Text style={[styles.buttonText, secondary && { color: '#143D35' }]}>{title}</Text>
    </Pressable>
  );
}
function Field({
  label,
  value,
  onChange,
  secure = false,
  multiline = false,
  placeholder = '',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  secure?: boolean;
  multiline?: boolean;
  placeholder?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
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
  enter: (session: SavedSession) => Promise<void>;
  message: string;
}) {
  const [origin, setOrigin] = useState(__DEV__ ? 'http://10.0.2.2:3333' : '');
  const [company, setCompany] = useState(__DEV__ ? 'aurora' : '');
  const [email, setEmail] = useState(__DEV__ ? 'tecnico@demo.local' : '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit() {
    setBusy(true);
    setError('');
    try {
      const session = await signIn(origin, company, email, password);
      setPassword('');
      await enter(session);
    } catch (e) {
      setError(errorText(e));
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
        label="Servidor da empresa"
        value={origin}
        onChange={setOrigin}
        placeholder="https://manutencao.suaempresa.com"
      />
      <Field label="Empresa" value={company} onChange={setCompany} />
      <Field label="E-mail" value={email} onChange={setEmail} />
      <Field label="Senha" value={password} onChange={setPassword} secure />
      <Button
        title={busy ? 'Entrando…' : 'Entrar e preparar meu turno'}
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
        <Text style={styles.title}>Ler a etiqueta da máquina</Text>
        <Text style={styles.muted}>A câmera é usada apenas para identificar o QR Code.</Text>
        <Button
          title="Permitir acesso à câmera"
          onPress={() => {
            void requestPermission();
          }}
        />
        <Button title="Voltar e buscar pelo código" secondary onPress={close} />
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
        <Button title="Voltar" secondary onPress={close} />
      </View>
    </View>
  );
}

function RequestForm({
  asset,
  save,
  back,
}: {
  asset: MobileAsset;
  save: (operation: MobileOperation) => Promise<void>;
  back: () => void;
}) {
  const [title, setTitle] = useState(''),
    [description, setDescription] = useState('');
  const [stopped, setStopped] = useState(false),
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
        kind: 'request.create',
        body: {
          asset_id: asset.id,
          title,
          description,
          machine_stopped: stopped,
          observed_at: observed.current,
        },
      });
      back();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Button title="Voltar aos ativos" secondary onPress={back} disabled={busy} />
      <Text style={styles.eyebrow}>
        {asset.code} · {asset.location}
      </Text>
      <Text style={styles.title}>Relatar um problema</Text>
      <Text style={styles.muted}>{asset.name}</Text>
      <Field label="O que aconteceu?" value={title} onChange={setTitle} />
      <Field
        label="Detalhes para a manutenção"
        value={description}
        onChange={setDescription}
        multiline
      />
      <View style={styles.row}>
        <Text style={[styles.label, { flex: 1 }]}>A máquina está parada</Text>
        <Switch
          accessibilityLabel="A máquina está parada"
          value={stopped}
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
        title={busy ? 'Salvando…' : 'Salvar solicitação no aparelho'}
        onPress={() => void submit()}
        disabled={busy}
      />
    </ScrollView>
  );
}

function OrderDetail({
  order,
  asset,
  queued,
  save,
  back,
}: {
  order: MobileOrder;
  asset?: MobileAsset;
  queued: boolean;
  save: (operation: MobileOperation) => Promise<void>;
  back: () => void;
}) {
  const [answers, setAnswers] = useState<Answers>(() =>
    Object.fromEntries(order.checklist.filter((i) => i.answer).map((i) => [i.id, i.answer!])),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const id = useRef(Crypto.randomUUID());
  const editable = ['in_progress', 'paused'].includes(order.status) && !queued;
  async function submit() {
    setBusy(true);
    setError('');
    try {
      await save({
        id: id.current,
        kind: 'order.checklist',
        order_id: order.id,
        body: { version: order.version, answers },
      });
      back();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Button title="Voltar às minhas OS" secondary onPress={back} disabled={busy} />
      <Text style={styles.eyebrow}>
        OS {order.number} · {statusLabels[order.status]}
      </Text>
      <Text style={styles.title}>{order.title}</Text>
      <Text style={styles.muted}>
        {asset?.code} · {asset?.name}
      </Text>
      <Text style={styles.body}>{order.description || 'Sem observações adicionais.'}</Text>
      <Text style={styles.caption}>
        Prazo: {order.due_date.split('-').reverse().join('/')} · Prioridade{' '}
        {priorityLabels[order.priority]}
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
      {order.checklist.length === 0 && (
        <Text style={styles.muted}>Esta OS não possui checklist.</Text>
      )}
      {order.checklist.map((item, index) => (
        <View key={item.id} style={styles.card}>
          <Text style={styles.label}>
            {index + 1}. {item.label}
          </Text>
          <View style={styles.answerRow}>
            {(['ok', 'nok', 'na'] as const).map((answer) => (
              <Pressable
                key={answer}
                accessibilityRole="radio"
                accessibilityState={{
                  checked: answers[item.id] === answer,
                  disabled: !editable || busy,
                }}
                accessibilityLabel={`${item.label}: ${answer === 'ok' ? 'OK' : answer === 'nok' ? 'Falha' : 'Não se aplica'}`}
                disabled={!editable || busy}
                onPress={() => setAnswers({ ...answers, [item.id]: answer })}
                style={[styles.answer, answers[item.id] === answer && styles.answerSelected]}
              >
                <Text style={styles.label}>
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
      {editable && order.checklist.length > 0 && (
        <Button
          title={busy ? 'Salvando…' : 'Salvar respostas no aparelho'}
          onPress={() => void submit()}
          disabled={busy || Object.keys(answers).length === 0}
        />
      )}
    </ScrollView>
  );
}

function QueueCard({
  entry,
  order,
  retry,
  dismiss,
}: {
  entry: OutboxEntry;
  order?: MobileOrder;
  retry: () => void;
  dismiss: () => void;
}) {
  const op: MobileOperation = JSON.parse(entry.payload);
  const labels = {
    pending: 'Aguardando envio',
    confirmed: 'Confirmado pelo servidor',
    conflict: 'Precisa de revisão',
    rejected: 'Envio recusado',
    superseded: 'Revisão registrada',
    dismissed: 'Arquivado neste aparelho',
  };
  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>{labels[entry.state]}</Text>
      <Text style={styles.cardTitle}>
        {op.kind === 'request.create'
          ? op.body.title
          : `Checklist · OS ${order?.number ?? op.order_id.slice(0, 8)}`}
      </Text>
      <Text style={styles.caption}>{new Date(entry.created_at).toLocaleString('pt-BR')}</Text>
      {op.kind === 'request.create' && <Text style={styles.body}>{op.body.description}</Text>}
      {entry.error && <Text style={styles.warning}>{entry.error}</Text>}
      {op.kind === 'order.checklist' &&
        ['conflict', 'rejected', 'dismissed'].includes(entry.state) && (
          <>
            <Text style={styles.label}>Suas respostas preservadas</Text>
            {Object.entries(op.body.answers).map(([key, value]) => (
              <Text key={key} style={styles.body}>
                {order?.checklist.find((i) => i.id === key)?.label ?? key}: {value.toUpperCase()} ·
                servidor:{' '}
                {order?.checklist.find((i) => i.id === key)?.answer?.toUpperCase() ??
                  'sem resposta'}
              </Text>
            ))}
            {entry.state === 'conflict' && order && (
              <Button title="Revisar e reaplicar minhas respostas" secondary onPress={retry} />
            )}
          </>
        )}
      {entry.state === 'rejected' && (
        <Text style={styles.caption}>
          Os dados foram preservados. Consulte o gestor para corrigir o acesso ou o registro.
        </Text>
      )}
      {['conflict', 'rejected'].includes(entry.state) && (
        <Button title="Arquivar tentativa neste aparelho" secondary onPress={dismiss} />
      )}
    </View>
  );
}

function Main() {
  const [runtime, setRuntime] = useState<MobileRuntime | null>(null),
    [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<CachedRecord[]>([]),
    [queue, setQueue] = useState<OutboxEntry[]>([]),
    [lastSync, setLastSync] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>('orders'),
    [search, setSearch] = useState('');
  const [selectedOrder, setSelectedOrder] = useState<string | null>(null),
    [requestAsset, setRequestAsset] = useState<string | null>(null),
    [scanner, setScanner] = useState(false);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [connected, setConnected] = useState(false);
  const syncing = useRef(false),
    syncRef = useRef<() => void>(() => {});
  const assets = records.filter((r) => r.entity === 'asset').map((r) => r.data as MobileAsset);
  const orders = records.filter((r) => r.entity === 'order').map((r) => r.data as MobileOrder);
  const unresolved = queue.filter((o) => ['pending', 'conflict', 'rejected'].includes(o.state));
  async function refresh(rt: MobileRuntime) {
    const [items, operations, time] = await Promise.all([
      rt.store.records(),
      rt.store.queue(),
      rt.store.lastSync(),
    ]);
    setRecords(items);
    setQueue(operations);
    setLastSync(time);
  }
  async function enter(session: SavedSession, fresh = false) {
    const rt = await openRuntime(session);
    try {
      if (fresh) {
        await rt.store.lockCache();
        await saveSession(session);
      }
      await refresh(rt);
    } catch (error) {
      await rt.close();
      throw error;
    }
    setRuntime(rt);
    setScreen(session.user.role === 'operator' ? 'assets' : 'orders');
    setMessage('');
    setSelectedOrder(null);
    setRequestAsset(null);
  }
  useEffect(() => {
    void (async () => {
      try {
        const session = await savedSession();
        if (session && Date.parse(session.expires_at) > Date.now()) await enter(session);
        else if (session)
          setMessage(
            'Sua sessão terminou. Conecte-se e entre novamente na mesma conta para recuperar a fila.',
          );
      } catch (e) {
        setMessage(errorText(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);
  async function sync() {
    if (!runtime || syncing.current) return;
    syncing.current = true;
    setBusy(true);
    try {
      if (Date.parse(runtime.session.expires_at) <= Date.now())
        throw new SyncError('Sua sessão terminou. Entre novamente para continuar.', 401);
      await runtime.engine.sync();
      await refresh(runtime);
      setConnected(true);
      setMessage('');
    } catch (e) {
      setConnected(false);
      setMessage(errorText(e));
      if (e instanceof SyncError && e.status === 401) {
        setRuntime(null);
        setRecords([]);
        setQueue([]);
        setSelectedOrder(null);
        setRequestAsset(null);
        setScanner(false);
        try {
          await runtime.invalidate();
        } catch {
          setMessage(
            'Acesso bloqueado. Não foi possível limpar o cache; entre novamente com conexão.',
          );
        } finally {
          await runtime.close().catch(() => {});
        }
      } else {
        try {
          await refresh(runtime);
        } catch (localError) {
          setMessage(errorText(localError));
        }
      }
    } finally {
      syncing.current = false;
      setBusy(false);
    }
  }
  syncRef.current = () => {
    // Avoid replacing the downloaded version while the user is filling a form.
    if (runtime && Date.parse(runtime.session.expires_at) <= Date.now()) {
      void sync();
      return;
    }
    if (!selectedOrder && !requestAsset && !scanner) void sync();
  };
  useEffect(() => {
    if (!runtime) return;
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
  }, [runtime]);
  async function save(operation: MobileOperation) {
    if (!runtime || Date.parse(runtime.session.expires_at) <= Date.now())
      throw new Error('Conecte-se e entre novamente antes de salvar.');
    await runtime.store.enqueue(operation);
    await refresh(runtime);
    setMessage('Salvo neste aparelho. A confirmação aparecerá na fila após sincronizar.');
  }
  function onQr(value: string) {
    setScanner(false);
    const token = qrIdentifier(value),
      asset = assets.find((item) => item.qr_token === token);
    if (!asset) {
      Alert.alert(
        'Ativo não disponível',
        'Este QR não corresponde aos ativos baixados nesta unidade. Conecte-se e sincronize, ou busque pelo código.',
      );
      return;
    }
    setRequestAsset(asset.id);
  }
  function retry(entry: OutboxEntry) {
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
                await runtime!.store.reapplyChecklist(entry.id, Crypto.randomUUID());
                await refresh(runtime!);
              } catch (e) {
                Alert.alert('Revisão não aplicada', errorText(e));
              }
            })();
          },
        },
      ],
    );
  }
  function dismiss(entry: OutboxEntry) {
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
                await runtime!.store.dismiss(entry.id);
                await refresh(runtime!);
              } catch (e) {
                Alert.alert('Não foi possível arquivar', errorText(e));
              }
            })();
          },
        },
      ],
    );
  }
  async function logout() {
    if (!runtime || busy) return;
    if (unresolved.length) {
      Alert.alert(
        'Há registros no aparelho',
        'Sincronize e revise as pendências antes de sair. Se o acesso mudou, os registros ficam protegidos para recuperação na mesma conta.',
      );
      return;
    }
    setBusy(true);
    try {
      await runtime.logout();
      setRuntime(null);
      setRecords([]);
      setQueue([]);
      setMessage('');
      try {
        await runtime.invalidate();
      } finally {
        await runtime.close();
      }
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (loading)
    return (
      <View style={styles.content}>
        <Text style={styles.title}>Preparando o aparelho…</Text>
      </View>
    );
  if (!runtime) return <Login enter={(session) => enter(session, true)} message={message} />;
  const order = orders.find((item) => item.id === selectedOrder),
    asset = assets.find((item) => item.id === requestAsset);
  if (scanner) return <Scanner onCode={onQr} close={() => setScanner(false)} />;
  if (asset)
    return (
      <RequestForm key={asset.id} asset={asset} save={save} back={() => setRequestAsset(null)} />
    );
  if (order)
    return (
      <OrderDetail
        key={order.id + ':' + order.version}
        order={order}
        asset={assets.find((a) => a.id === order.asset_id)}
        queued={unresolved.some((o) => o.order_id === order.id)}
        save={save}
        back={() => setSelectedOrder(null)}
      />
    );
  const filteredAssets = assets.filter((item) =>
    `${item.code} ${item.name} ${item.location}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.logo}>pulso.</Text>
          <Text style={styles.headerCaption}>{runtime.session.user.site_name}</Text>
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
          {unresolved.length} pendente(s)
        </Text>
        <Pressable
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Sincronizar agora"
          onPress={() => void sync()}
          style={styles.syncButton}
        >
          <Text style={styles.label}>Sincronizar</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {!!message && (
          <Text accessibilityRole="alert" style={styles.warning}>
            {message}
          </Text>
        )}
        <Text style={styles.eyebrow}>
          OLÁ, {runtime.session.user.name.split(' ')[0].toUpperCase()}
        </Text>
        <Text style={styles.title}>
          {screen === 'orders'
            ? 'Minhas ordens'
            : screen === 'assets'
              ? 'Ativos da unidade'
              : 'Fila de sincronização'}
        </Text>
        <Text style={styles.caption}>
          {lastSync
            ? 'Última atualização: ' + new Date(lastSync).toLocaleString('pt-BR')
            : 'Sincronize com conexão para baixar os primeiros dados.'}
        </Text>
        {screen === 'orders' && (
          <>
            <Text style={styles.muted}>
              Ordens atribuídas a você, prontas para consulta no chão de fábrica.
            </Text>
            {orders.length === 0 && (
              <View style={styles.card}>
                <Text style={styles.body}>Nenhuma OS baixada para você.</Text>
              </View>
            )}
            {[...orders]
              .sort((a, b) => a.due_date.localeCompare(b.due_date))
              .map((item) => (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Abrir OS ${item.number}: ${item.title}`}
                  disabled={busy}
                  onPress={() => setSelectedOrder(item.id)}
                  style={styles.card}
                >
                  <View style={styles.row}>
                    <Text style={styles.eyebrow}>OS {item.number}</Text>
                    <Text style={styles.pill}>{statusLabels[item.status]}</Text>
                  </View>
                  <Text style={styles.cardTitle}>{item.title}</Text>
                  <Text style={styles.muted}>
                    {assets.find((a) => a.id === item.asset_id)?.code} ·{' '}
                    {priorityLabels[item.priority]}
                  </Text>
                  <Text style={styles.caption}>
                    Prazo {item.due_date.split('-').reverse().join('/')}
                  </Text>
                </Pressable>
              ))}
          </>
        )}
        {screen === 'assets' && (
          <>
            <Button
              title="Ler QR Code da máquina"
              onPress={() => setScanner(true)}
              disabled={!lastSync || busy}
            />
            <Field
              label="Buscar ativo"
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
                accessibilityLabel={`Abrir solicitação para ${item.code}`}
                disabled={busy}
                onPress={() => setRequestAsset(item.id)}
                style={styles.card}
              >
                <Text style={styles.eyebrow}>
                  {item.code} · {item.location}
                </Text>
                <Text style={styles.cardTitle}>{item.name}</Text>
                <Text style={styles.link}>Relatar um problema →</Text>
              </Pressable>
            ))}
          </>
        )}
        {screen === 'queue' && (
          <>
            <Text style={styles.muted}>
              Os registros permanecem neste aparelho até a confirmação. Conflitos exigem revisão;
              suas respostas são preservadas.
            </Text>
            {queue.length === 0 && (
              <View style={styles.card}>
                <Text style={styles.body}>
                  Tudo em dia. Nenhuma operação registrada neste aparelho.
                </Text>
              </View>
            )}
            {[...queue].reverse().map((entry) => (
              <QueueCard
                key={entry.id}
                entry={entry}
                order={orders.find((o) => o.id === entry.order_id)}
                retry={() => retry(entry)}
                dismiss={() => dismiss(entry)}
              />
            ))}
          </>
        )}
      </ScrollView>
      <View accessibilityRole="tablist" style={styles.tabs}>
        {(
          [
            ['orders', 'Minhas OS'],
            ['assets', 'Ativos'],
            ['queue', `Fila (${unresolved.length})`],
          ] as const
        )
          .filter(([key]) => key !== 'orders' || runtime.session.user.role === 'technician')
          .map(([key, label]) => (
            <Pressable
              key={key}
              accessibilityRole="tab"
              accessibilityState={{ selected: screen === key }}
              onPress={() => setScreen(key)}
              style={[styles.tab, screen === key && styles.tabSelected]}
            >
              <Text style={styles.label}>{label}</Text>
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
  title: { color: '#173E34', fontSize: 28, fontWeight: '700', lineHeight: 34 },
  sectionTitle: { color: '#173E34', fontSize: 20, fontWeight: '700', marginTop: 12 },
  muted: { color: '#52665C', fontSize: 15, lineHeight: 23 },
  caption: { color: '#52665C', fontSize: 12, lineHeight: 19 },
  body: { color: '#2A4035', fontSize: 16, lineHeight: 24 },
  field: { gap: 8 },
  label: { color: '#173E34', fontSize: 15, fontWeight: '600' },
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
  answerRow: { flexDirection: 'row', gap: 8 },
  answer: {
    flex: 1,
    minHeight: 56,
    borderWidth: 1,
    borderColor: '#D4DFD0',
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  answerSelected: { backgroundColor: '#D7EDAD', borderColor: '#638C40', borderWidth: 2 },
});
