# Pulso Android — incremento 0.2

Aplicativo React Native/Expo para técnicos e solicitantes. Consome as validações e o protocolo de sincronização do pacote `@pulso/contracts` e usa SQLite com SQLCipher, chave no SecureStore e uma fila persistente de operações.

## Fluxos implementados

- Login online por empresa, com token próprio do dispositivo e sessão de 8 horas.
- Download dos ativos da unidade e das OS atribuídas ao técnico.
- Consulta dos registros baixados sem conexão; busca por código/nome/setor e leitura do QR por câmera.
- Solicitações salvas no aparelho com horário da ocorrência, descrição e indicação de parada.
- Respostas de checklist salvas offline para OS já iniciadas ou pausadas.
- Sincronização manual, ao voltar ao aplicativo e a cada 30 segundos enquanto ativo e fora de formulários.
- Fila visível: pendente, confirmado, conflito, recusado, revisado ou arquivado.
- Revisão explícita de conflitos, comparando respostas locais e respostas atuais antes de criar outra tentativa.

O botão **Salvar no aparelho** persiste a operação. Texto apenas digitado e ainda não salvo não é um rascunho persistente. Campos não são enviados automaticamente ao digitar. Início/pausa/conclusão de OS, consumo de peças, fotos e apontamentos offline ainda estão pendentes.

## Contrato compartilhado

As regras de validação, o protocolo 1 de sincronização e o motor offline (`OfflineStore`, `SyncEngine`) vêm do pacote [`@pulso/contracts`](https://github.com/Leo-501/pulso-contracts), fixado por tag no `package.json`. Eles não moram mais neste repositório.

Consequência prática: **subir a tag do contrato é uma decisão de compatibilidade, não uma atualização de rotina.** Um aplicativo já instalado no aparelho do técnico continua falando com a API publicada. Antes de mover a tag, confirme que a API em produção já aceita a versão nova, e rode `pnpm test` no repositório `pulso-cmms` — é lá que mora o teste que exercita servidor e cliente juntos.

`zod` está nas dependências deste repositório porque o contrato o declara como peer. Mantenha a versão idêntica à do contrato.

## Executar em desenvolvimento

Neste repositório:

```powershell
pnpm install
```

O aplicativo conversa com a API, que vive no repositório `pulso-cmms`. Em outro terminal, lá:

```powershell
pnpm dev
```

Com JDK e Android SDK configurados e emulador ou dispositivo disponível, de volta a este repositório:

```powershell
$env:PULSO_ALLOW_LOCAL_HTTP = '1'
pnpm exec expo prebuild --platform android --no-install
pnpm android
```

O build de desenvolvimento precisa incluir SQLCipher; **Expo Go não é compatível**. O aplicativo verifica a presença do SQLCipher ao abrir o banco e recusa um banco sem essa extensão.

No emulador padrão Android, use `http://10.0.2.2:3333` como servidor. No aparelho físico por USB, uma alternativa é `adb reverse tcp:3333 tcp:3333` e servidor `http://127.0.0.1:3333`. A conexão do Metro também precisa estar disponível no aparelho; a CLI do Expo orienta essa conexão.

Conta fictícia: empresa `aurora`, e-mail `tecnico@demo.local` ou `operador@demo.local`, senha `Demo@2026!`. Gestores, administradores e almoxarifes usam o painel web neste incremento.

Para iniciar só o Metro depois de instalar o build nativo:

```powershell
pnpm start
```

`PULSO_ALLOW_LOCAL_HTTP=1` habilita HTTP no manifesto nativo para desenvolvimento local; exige novo prebuild/build. A configuração padrão é HTTPS. O código de release também rejeita servidores HTTP, mesmo que um manifesto de desenvolvimento tenha sido reaproveitado.

## Validar e compilar

```powershell
pnpm typecheck
pnpm export:android
```

`export:android` gera o bundle Hermes Android em `dist`; não é um APK. `expo prebuild` gera o projeto Android com configuração de SQLCipher e backup automático desativado. Os diretórios nativos gerados são ignorados pelo Git.

Para um APK de desenvolvimento ARM64 depois do prebuild, com JDK/SDK configurados:

```powershell
cd android
./gradlew.bat assembleDebug -PreactNativeArchitectures=arm64-v8a --max-workers=2
```

Esse APK usa o Metro durante o desenvolvimento. Um build instalável para piloto exige empacotamento de release, assinatura e homologação. A configuração de release, distribuição e pipeline ainda serão concluídos.

**Validação em 13/09/2026:** tipos, bundle Hermes, prebuild e testes do protocolo aprovados. O APK não foi gerado: o ambiente local esgotou espaço durante a instalação do NDK e memória durante a compilação Java/Kotlin, inclusive após reduzir a concorrência. Nenhum dispositivo Android estava conectado para homologação.

Em máquinas com recursos limitados, a tentativa pode usar um único worker e compilação Kotlin no mesmo processo:

```powershell
./gradlew.bat assembleDebug -PreactNativeArchitectures=arm64-v8a '-Dorg.gradle.jvmargs=-Xmx1024m -XX:MaxMetaspaceSize=384m -XX:ActiveProcessorCount=2 -Dfile.encoding=UTF-8' -Pkotlin.compiler.execution.strategy=in-process --no-daemon --max-workers=1 --no-parallel
```

Garanta espaço para Gradle, Android SDK/NDK e arquivos intermediários, além de memória disponível. A localização dos caches pode ser configurada por `GRADLE_USER_HOME`, `ANDROID_HOME` e diretório temporário sem mover o código principal.

## Persistência e limites

- Banco separado por servidor, empresa, unidade e usuário. O token e a chave aleatória não ficam no SQLite nem no código.
- Repetir um envio mantém o UUID e o conteúdo; a API confirma a operação e seu recibo na mesma transação.
- A substituição dos dados baixados e a data da sincronização são aplicadas numa única transação SQLite.
- Conflitos não sobrescrevem respostas automaticamente. Reaplicar cria outro UUID sobre a versão revisada; a tentativa anterior permanece no histórico.
- A reatribuição remove a OS baixada. A fila é preservada e uma tentativa sem autorização fica recusada, com seus dados para revisão.
- Ao receber `401`, o aplicativo bloqueia a interface, remove a sessão local e limpa os dados baixados. A fila criptografada permanece para a mesma conta após nova autenticação.
- Mudança de perfil exige nova autenticação; um login novo limpa os registros baixados antes de persistir a nova sessão, preservando a fila do mesmo escopo.
- A sessão offline é limitada a 8 horas e usa o relógio do aparelho. A revogação no servidor é percebida na próxima conexão; homologar relógio/dispositivo gerenciado antes do piloto.
- O logout exige conexão e resolução ou arquivamento explícito das pendências. Arquivar não desfaz uma operação que já tenha chegado ao servidor.
- Sem execução em segundo plano ou notificações push neste incremento.
- O protocolo inicial compara um manifesto de identificadores/hashes: apenas registros alterados e remoções trafegam na resposta. A API ainda consulta o conjunto completo, limitado a 5.000 ativos e 5.000 OS por sincronização; exceder o limite falha explicitamente. Paginação com cursor está pendente.

Os testes de fila usam SQLite real no Node e falhas de transporte simuladas. Testes de API usam PostgreSQL embarcado. Isso não substitui validar SQLCipher, câmera, teclado, processo encerrado e modo avião em Android real.

Referências: [Expo SQLite/SQLCipher](https://docs.expo.dev/versions/latest/sdk/sqlite/#sqlcipher), [SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/), [configuração do Metro](https://docs.expo.dev/guides/customizing-metro/).
