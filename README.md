# dbeaver-readonly-mcp

Servidor MCP que dá a um cliente MCP (Claude Code, Claude Desktop e afins) acesso **somente leitura** aos bancos que você já tem configurados no DBeaver, sem copiar credenciais para outro lugar.

## Como funciona

- Lê host, porta, usuário e senha da configuração do DBeaver no momento em que sobe.
- Só expõe as conexões listadas em `allowlist.json`, pelo nome que elas têm no DBeaver.
- Toda consulta roda com `default_transaction_read_only=on`, dentro de `BEGIN READ ONLY` e com `ROLLBACK` no fim, com timeout de 15s e limite de linhas.
- Aceita um único statement por chamada (protocolo estendido), então `COMMIT; DROP ...` é recusado.
- Usa o seu usuário do banco: enxerga exatamente o que você enxerga no DBeaver.

Ferramentas: `list_connections`, `query`, `list_tables` (com dono e se você tem `SELECT`) e `describe_table`.

Hoje só PostgreSQL. Outros bancos precisam de driver novo.

## Requisitos

- Node 20+.
- DBeaver com a senha salva na conexão ("Save password"). Senhas guardadas no Secure Storage (keychain do sistema) não são lidas.

A configuração do DBeaver é procurada em:

| Sistema | Pasta |
| --- | --- |
| macOS | `~/Library/DBeaverData/workspace6/General/.dbeaver` |
| Linux | `~/.local/share/DBeaverData/workspace6/General/.dbeaver` |
| Windows | `%APPDATA%\DBeaverData\workspace6\General\.dbeaver` |

Para outro workspace ou projeto, defina `DBEAVER_CONFIG_DIR`. Para guardar o allowlist em outro lugar, `DBEAVER_MCP_ALLOWLIST`.

## Instalação

```bash
git clone <repo> ~/.claude/mcp/dbeaver-readonly
cd ~/.claude/mcp/dbeaver-readonly
npm install
cp allowlist.example.json allowlist.json
claude mcp add --scope user dbeaver-readonly -- "$(which node)" ~/.claude/mcp/dbeaver-readonly/index.js
```

Se o `node` padrão do shell for anterior ao 20, passe o caminho de um Node 20+ no `claude mcp add`.

## allowlist.json

```json
{
  "connections": {
    "MEU-POSTGRES-LOCAL": {},
    "MEU-POSTGRES-STG": { "database": "meu_banco", "ssl": true },
    "MEU-RDS-COM-DNS-PROPRIO": {
      "caFile": "certs/rds-global-bundle.pem",
      "tlsServerName": "minha-instancia.abc123xyz.us-east-1.rds.amazonaws.com"
    }
  }
}
```

A chave é o nome da conexão no DBeaver. Todos os campos são opcionais:

- `database`: sobrescreve o banco da conexão, útil quando ela aponta para `postgres` e o banco de trabalho é outro.
- `ssl`: `true` para TLS validado pelas CAs do sistema. Ausente, conecta sem TLS.
- `caFile`: arquivo PEM com a CA que assina o certificado do servidor, relativo a esta pasta. Liga o TLS.
- `tlsServerName`: nome a conferir no certificado quando o host da conexão é um apelido (CNAME) que o certificado não cobre. Liga o TLS.

Não há opção para desligar a verificação do certificado: se ela falhar, informe a CA certa em `caFile`.

### Amazon RDS

O certificado do RDS é assinado pelas CAs próprias da AWS, que não estão no sistema. `npm run fetch-rds-ca` baixa o bundle global oficial para `certs/rds-global-bundle.pem`.

Se você conecta por um DNS próprio que aponta para a instância, o certificado só cobre o endpoint `*.rds.amazonaws.com`. Coloque esse endpoint em `tlsServerName`. Para descobrir qual é:

```bash
dig +short meu-banco.minha-empresa.com CNAME
```

## Cuidados

Libere bancos de produção com cuidado: o modo só leitura impede escrita, mas os dados retornados vão para o contexto do modelo.
