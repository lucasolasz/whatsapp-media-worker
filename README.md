# whatsapp-media-worker

Converte qualquer imagem ou vídeo para o formato que o WhatsApp entrega em todo aparelho. O serviço não guarda estado nem credenciais de bucket e não conhece quem o chama: recebe o arquivo bruto e devolve o arquivo pronto, ou o grava numa URL de upload que quem chama informou.

| Entrada | Saída |
|---|---|
| JPG, PNG, WEBP | JPEG, até 1600 px, com rotação EXIF aplicada e fundo branco no lugar de transparência (máx. 5 MB) |
| MP4, MOV, WEBM (inclusive HEVC/HDR de iPhone) | MP4 H.264 main + AAC, até 1280 px, até 30 fps, `yuv420p`, `+faststart`, com bitrate calculado pela duração para caber em 15 MB (máx. 16 MB) |

Vídeo acima de cerca de 4 minutos é recusado: não cabe nos 16 MB com qualidade aceitável.

## API

Toda rota (menos `/saude`) exige `Authorization: Bearer <token>`.

### `POST /conversoes`

O corpo é o próprio arquivo, e o `Content-Type` é o tipo dele (ex.: `video/quicktime`). Responde `202 { "id": "<uuid>" }`. As conversões rodam uma por vez.

### `GET /conversoes/{id}`

```json
{ "status": "processando | pronta | erro", "progresso": 0-100, "content_type": "video/mp4", "tamanho": 9789549, "erro": "mensagem para o usuário" }
```

### `GET /conversoes/{id}/arquivo`

Devolve o arquivo pronto. Só existe no modo download.

### `GET /saude`

Devolve `{ "ok": true }`. É usado pelo healthcheck do Docker.

### Modos

- **Download:** o token não tem `destino_url`. O resultado fica no worker até `RETENCAO_MINUTOS` e quem chama baixa o arquivo em `/arquivo`.
- **Destino:** o token tem `destino_url`, uma URL de `PUT` já assinada (por exemplo, uma URL pré-assinada de S3). O worker envia o resultado para ela com o `Content-Type` de saída e apaga a cópia local. Nesse modo, `pronta` significa que o arquivo já está no destino. Quem assina a URL precisa usar o tipo de saída: `image/jpeg` para imagem e `video/mp4` para vídeo.

### Erros

| Status | Quando |
|---|---|
| 401 | Token ausente, inválido ou expirado |
| 404 | Conversão inexistente, ou de outro token |
| 409 | Token já usado, ou arquivo pedido no modo destino |
| 413 | Arquivo acima do limite |
| 415 | Formato não aceito |

## Token

```
token = base64url(payload) + "." + base64url(HMAC-SHA256(segredo, base64url(payload)))
payload = { "exp": <unix s>, "jti": "<uuid>", "destino_url"?: "...", "tamanho_maximo"?: <bytes> }
```

- O token é gerado pelo **backend** de quem chama, que conhece o segredo. O browser só repassa.
- Cada token cria **uma** conversão e serve para consultar só ela.
- `tamanho_maximo` reduz o limite global do worker para aquele envio.

Exemplo em Node:

```js
import { createHmac, randomUUID } from "node:crypto";

const payload = Buffer.from(JSON.stringify({
  exp: Math.floor(Date.now() / 1000) + 3600,
  jti: randomUUID(),
  destino_url: urlAssinadaDePut,
})).toString("base64url");
const token = `${payload}.${createHmac("sha256", segredo).update(payload).digest("base64url")}`;
```

## Variáveis

| Variável | Padrão | Uso |
|---|---|---|
| `SEGREDOS_TOKEN` | obrigatória | Segredos aceitos, separados por vírgula: um por app cliente, ou o antigo e o novo durante uma troca. Cada um precisa ter 32+ caracteres, senão o worker não sobe |
| `CORS_ORIGENS` | vazio | Origens de browser liberadas (ex.: `https://app.vercel.app,http://localhost:3000`). Precisa do `http://` ou `https://`; barra final, caminho e aspas são ignorados |
| `DESTINOS_PERMITIDOS` | vazio | Hosts aceitos em `destino_url` (ex.: `s3.seudominio.com`). Pode vir com ou sem protocolo, barra final ou caminho: só o host (e a porta, se não for a padrão) é comparado. Vazio desliga o modo destino |
| `TAMANHO_MAXIMO_MB` | `100` | Limite do arquivo de entrada |
| `RETENCAO_MINUTOS` | `60` | Tempo que um resultado não baixado fica no worker |
| `PORT` | `3000` | Porta HTTP |
| `TZ` | UTC | Fuso do horário nos logs (ex.: `America/Sao_Paulo`). Os templates de deploy já vêm com `America/Sao_Paulo` |

## Deploy no Easypanel

O arquivo `easypanel-schema.json` cria o serviço já configurado. O Easypanel clona este repositório e builda o `Dockerfile`: não precisa publicar imagem.

1. Se o repositório for privado, conecte o GitHub em Easypanel → **Settings → GitHub** (token com leitura do repo).
2. Copie o `easypanel-schema.json` e troque:
   - `GERE_UM_SEGREDO` por um segredo de 32+ caracteres (ex.: `openssl rand -hex 32`). Com o placeholder, o worker não sobe;
   - `CORS_ORIGENS` e `DESTINOS_PERMITIDOS`;
   - `owner`, `repo` e `ref`, se forem outros.
3. No projeto do Easypanel: **+ Service → Templates → Create From Schema**, cole e crie.
4. Em Advanced, defina um limite de CPU (ex.: 1,5) para o ffmpeg não disputar CPU com os outros serviços. O schema já limita a memória em 1 GB.
5. Confira `GET https://<dominio>/saude`.

O deploy automático a cada push vem desligado (`autoDeploy: false`): clique em **Deploy** depois de atualizar o código, ou ligue no serviço. Um redeploy no meio de uma conversão a perde, e quem chamou precisa enviar de novo.

Se uploads grandes caírem perto de 60 s, aumente o `readTimeout` do Traefik. Na v3 o padrão é 60 s para ler a requisição inteira.

## Deploy no Dokploy

A pasta `dokploy/` tem um template no formato do [Dokploy/templates](https://github.com/Dokploy/templates): `docker-compose.yml` e `template.toml`. O compose builda direto do repositório (`build.context` com a URL do Git), então o repositório precisa ser público. Não é preciso abrir PR no repositório de templates: ele é para templates públicos, e este é importado direto no painel.

1. Gere o valor de importação (JSON com `compose` e `config`, em base64):
   ```
   node -e "const f=require('fs');console.log(Buffer.from(JSON.stringify({compose:f.readFileSync('dokploy/docker-compose.yml','utf8'),config:f.readFileSync('dokploy/template.toml','utf8')})).toString('base64'))"
   ```
2. No projeto do Dokploy: **Create Service → Compose**, abra o serviço e, em **Advanced → Import**, cole o base64 e confirme.
3. Em **Environment**, troque `CORS_ORIGENS` e `DESTINOS_PERMITIDOS`. O `SEGREDOS_TOKEN` já vem aleatório com 64 caracteres: copie-o para o `MEDIA_WORKER_SEGREDO` do cliente.
4. Em **Domains**, troque o domínio gerado pelo definitivo (porta 3000, HTTPS).
5. Clique em **Deploy** e confira `GET https://<dominio>/saude`.

O compose limita a memória em 1 GB. Para limitar CPU, adicione `cpus: "1.5"` em `deploy.resources.limits`, sem passar do número de núcleos da máquina. Não há deploy automático: um push só entra com um novo **Deploy**, que perde as conversões em andamento.

### Sem Easypanel

```
docker build -t whatsapp-media-worker .
docker run -d -p 3000:3000 --env-file .env whatsapp-media-worker
```

## Operação

- O estado fica em memória. Um restart perde as conversões em andamento: o status responde 404 e quem chamou envia de novo.
- Os logs mostram o id da conversão, o tempo gasto e o fim do stderr do ffmpeg quando há falha. Não mostram tokens nem conteúdo de arquivos.
- Cada linha começa com data e hora no fuso de `TZ`, com o deslocamento (`2026-10-06T09:15:02-03:00`), e cada evento ocupa uma linha só.

## Desenvolvimento

```
npm install
SEGREDOS_TOKEN=dev CORS_ORIGENS=http://localhost:3000 npm start
```

É preciso ter `ffmpeg` e `ffprobe` no `PATH`.
