# firewall

Módulo do pvx que gerencia o firewall de uma central: listas de IPs e portas, aplicação com reversão automática, start-on-boot e uma aba "Firewall" na TUI. Funciona com firewalld, nftables ou iptables.

## Ficha de módulo

1. **Responsabilidade:** manter as listas de IPs e portas (aceitar e bloquear), aplicá-las no firewall do host por um dos três engines, com failsafe do IP da sessão SSH e reversão automática em 60 s sem confirmação, e reaplicar as listas no boot.
2. **Não faz:** não usa rede, não mexe em IPv6, não gerencia ufw, não toca em regras de terceiros (fail2ban, docker: o nftables usa só a tabela `ip pvx`, o iptables só a chain `PVX_INPUT`, o firewalld só rich rules com as prioridades do módulo), não lê dados de outros módulos. Fora de comandos só sonda (`exec` de leitura): `firewall.active` e as consultas `firewall.status` e `firewall.diff` conferem o engine vivo; os widgets leem só o registro do último apply.
3. **Comandos:**
   - `firewall status` (somente leitura): estado vivo; a primeira linha é `status: ATIVO|INATIVO N/M regra(s)`.
   - `firewall check` (somente leitura): diferença entre as regras vivas e as listas (o que um `apply` mudaria).
   - `firewall apply [--force] [--no-rollback]` (destrutivo): guarda um snapshot, garante o IP da sessão SSH (`SSH_CLIENT`, senão `who -m`; sem IP e sem `--force` aborta), agenda a reversão e aplica.
   - `firewall confirm`: cancela a reversão automática. `firewall revert` (destrutivo): volta ao snapshot agora.
   - `firewall ip accept|deny <ip[,ip]> [--comment]`, `ip remove`, `ip list`; `firewall port accept|deny|remove|list` (`5060/udp`, `10000-20000/tcp`, `80` = tcp e udp). `ip deny` recusa o IP da sessão atual e qualquer faixa que o contenha.
   - `firewall ip trust-phonevox`: adiciona os IPs base da Phonevox que faltam.
   - `firewall ip trust-asterisk [--accept all|ip,ip]`: lista os IPs públicos dos peers (`asterisk -rx`, sip e pjsip) com o nome do peer, sem privados, loopback nem IPs do próprio host; só grava com `--accept`. `--yes` sozinho nunca grava.
   - `firewall engine [auto|firewalld|nftables|iptables] [--zone Z]`.
   - `firewall boot enable|disable|status` (`enable [--dry-run] [--pvx-bin /usr/local/bin/pvx]`).
   - Aba **Firewall**: `[1] status`, `[2] IPs`, `[3] portas` (os quatro níveis de foco do `UI.md`: barra, página, painel, linha). `1`/`2`/`3` pulam para o painel; `enter` entra na lista e abre a linha (formulário de comentário, com `remover` e confirmação) ou a ação "+ adicionar…"; `a` adiciona (valor, ação aceitar/bloquear, comentário; erro inline), `t` confia nos IPs da Phonevox, `A` abre a revisão (`firewall.diff`), pede a confirmação do host e abre a contagem regressiva "ainda tem acesso? enter confirma". O status vem da consulta `firewall.status` (não entra no histórico). Erro de uma ação abre uma tela de resultado. Lado a lado a partir de 120 colunas (as quatro colunas não cabem em 100); abaixo disso empilhado, e em 80x24 só a lista com o foco aparece aberta. Toda mudança roda um comando do módulo.
4. **Capacidades e consultas:**
   - Capacidades: `firewall.active` (corrige com `firewall apply`), `firewall.base-ips` (`firewall ip trust-phonevox`, afeta `firewall.active`), `firewall.asterisk-ips` (`firewall ip trust-asterisk`, afeta `firewall.active`, opt-in).
   - Consultas: `firewall.missingBaseIps`, `firewall.status` (registro mais o engine vivo), `firewall.diff` (`{added, removed, session, missingBaseIps}`).
   - Widgets: `home.chips` (`firewall · <engine> · N regras`) e `home.attention` (IPs base que faltam, reversão pendente).
5. **Estado que grava:** no `state.json` do módulo: `state` (quatro listas de `{value, comment, source: base|asterisk|manual, addedBy, at}`), `engine`, `zone`, `lastApply`, `pending`, `asterisk`. Em `$PVX_HOME/modules/firewall/state/`: `snapshots/restore.sh` (script `sh` que devolve as regras anteriores) e `rollback.pending` (marcador da reversão). Fora dali: `/etc/systemd/system/pvx-firewall.service`.
6. **Permissões:** `exec`: `firewall-cmd`, `nft`, `iptables`, `iptables-save`, `iptables-restore`, `systemctl`, `systemd-run`, `asterisk`, `who`, `sh` (o `sh` roda o script de restauração e o fallback da reversão). `fs`: `rw:/etc/systemd/system/` (a unit) e `rw:$PVX_HOME/modules/firewall/state/` (snapshot e marcador). Nenhuma rede. Todo processo passa por `ctx.exec`.
7. **Depende de (`uses`):** nenhum módulo.

## Estrutura

- `src/index.tsx`: só liga as peças.
- `src/commands/{lists,asterisk,apply,boot,engine}.ts`: os comandos, por assunto (`context.ts` tem o que dividem).
- `src/health/{prove,summary,queries,widgets}.ts`: capacidades, leituras (registro, engine vivo, diff), consultas e widgets.
- `src/engines/`: `rules.ts` (ordem das regras), `common.ts`, `firewalld.ts`, `nft.ts`, `iptables.ts`, `index.ts` (escolha do engine).
- `src/apply.ts` (fluxo do apply), `rollback.ts`, `boot.ts` (unit), `asterisk.ts`, `net.ts`, `state.ts` (formatos gravados), `exec.ts`, `texts.ts`.
- `src/page/`: a aba, em componentes pequenos (`Firewall`, `MainScreen`, `StatusPanel`, `EntryPanel`, `EntryForm`, `ApplyReview`, `Countdown`, `ResultScreen`) mais `layout.ts` e `rows.ts` (lógica pura).

## Como funciona

**Engines.** `auto` escolhe firewalld se o serviço está ativo (ele é dono do nft: nunca se escreve nft ao lado), senão nftables se existe `nft`, senão iptables. Cada engine tem a mesma interface: `status`, `render(estado)`, `failsafeRule(ip)`, `apply`, `snapshot`, `restore`, `bootEnable`, `bootDisable`, `bootStatus`. A ordem das regras vive num lugar só (`engines/rules.ts`); cada engine só diz como escrever uma regra. nftables troca a tabela `ip pvx` numa transação; iptables recarrega a chain `PVX_INPUT` com um `iptables-restore --noflush`; firewalld adiciona e remove só a diferença das rich rules e recarrega. Ordem das regras: failsafe, estabelecidas, loopback e icmp, IPs bloqueados, IPs aceitos, portas bloqueadas, portas liberadas, drop. Bloqueio de porta vence a liberação.

**Reversão automática.** Antes de aplicar, `apply` grava o snapshot (um script `sh`), cria o marcador `rollback.pending` e agenda `systemd-run --on-active=60 sh -c '[ -f marcador ] && { sh restore.sh; rm -f marcador; }'`. Se `systemd-run` falha, usa um `nohup sh -c 'sleep 60; …'` desligado do terminal. O job é do systemd (ou do init): sobrevive ao pvx sair e à sessão SSH cair. `firewall confirm` remove o marcador (o que desarma os dois caminhos) e para o timer. Um segundo `apply` com um pendente mantém o snapshot mais antigo. Se a carga falha ou o IP da sessão não aparece entre as regras carregadas, o snapshot volta na hora.

**Start-on-boot.** Unit `pvx-firewall.service` (oneshot) com `ExecStart=<pvx> firewall apply --yes --force --no-rollback`. Um teste liga esse texto aos comandos e flags que o módulo registra (o módulo Python chamava um `sync` que não existia).

## Desenvolvimento

O repositório não tem `node_modules` e só importa tipos de `@pvx/sdk`. Os testes usam o host do pvx clonado ao lado, em `../pvx-opentui`: o `tsconfig.json` aponta `@pvx/*` para `../pvx-opentui/packages/*/src/index.ts` e o `bunfig.toml` reaproveita o `test/setup.ts` do host (um `PVX_HOME` temporário por teste).

```sh
bun test
```

Nenhum teste toca no firewall da máquina: os engines rodam com um `exec` falso, e os testes de história trocam o `PATH` por uma pasta só com scripts falsos de `nft`, `systemctl` e companhia (`test/stubs.ts`). Para ver o módulo no host real: `PVX_HOME=$(mktemp -d) pvx modules link <caminho>` (como root; o host exige) e `pvx --json firewall status` (a flag `--json` vem antes do módulo). Num host sem engine, `status` sai com "engine indisponível" e não altera nada.
