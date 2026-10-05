## Sobre o projeto

whatsapp-media-worker: API HTTP sem estado que converte imagem e vídeo para o formato que o WhatsApp entrega em todo aparelho. É genérico: não conhece quem o chama, não tem banco e não guarda credencial de bucket. O contrato público (rotas, token, variáveis, deploy) está no `README.md`; este arquivo traz as regras e o porquê das decisões.

Primeiro cliente: a dashboard **ltech-automate-dashboard** (pasta irmã `../ltech-automate-dashboard`), no cadastro de Mídias da IA. Lá, `lib/media-worker.ts` gera o token e `app/api/midias-ia/upload/route.ts` assina o PUT no bucket (RustFS). O browser manda o bruto direto para cá, porque a Vercel limita o corpo da request a 4,5 MB. As mídias convertidas são enviadas pelo WAHA no n8n com `convert: false`.

## Tecnologias e restrições

- Node 22+, ES modules (`.mjs`), JavaScript puro, sem build e sem TypeScript.
- Dependências: só `sharp` (imagem). Vídeo usa `ffmpeg`/`ffprobe` do sistema (`apk add ffmpeg` no `Dockerfile`).
- HTTP com `node:http`, sem framework. Antes de adicionar uma dependência, verificar se a biblioteca padrão resolve.
- Deploy: container no Easypanel (Contabo) pelo `easypanel-schema.json` (origem GitHub + `Dockerfile`, `autoDeploy: false`). A mesma máquina roda WAHA e n8n.

## Estrutura

| Arquivo | Responsabilidade |
|---|---|
| `src/servidor.mjs` | Rotas, CORS, autenticação, recepção do upload em disco, variáveis de ambiente, limpeza periódica |
| `src/token.mjs` | Validação do token HMAC (`verificarToken`) |
| `src/conversoes.mjs` | Estado das conversões em memória, fila, entrega no destino (PUT) e retenção |
| `src/conversao.mjs` | ffmpeg/sharp: formatos aceitos, parâmetros de saída, limites e mensagens de erro para o usuário |

## Contrato (não quebrar)

As rotas, os campos de resposta (`status`, `progresso`, `content_type`, `tamanho`, `erro`), o formato do token e os nomes das variáveis são usados pelos clientes. Qualquer mudança neles precisa ser:

- compatível com os clientes atuais, ou
- feita junto com a mudança nos clientes. Na dashboard: `lib/media-worker.ts` e `enviarArquivoMidia` em `services/midia-ia-service.ts`.

Sempre atualizar o `README.md`.

## Regras de conversão (`src/conversao.mjs`)

- **Saída fixa:** JPEG para imagem, MP4 para vídeo. Quem chama assina o PUT com esse tipo antes da conversão, por isso o tipo de saída não pode depender do conteúdo.
- **Vídeo:**
  - H.264 `main` + AAC, `yuv420p`: vídeo HDR/10-bit de iPhone vira 8-bit compatível.
  - `+faststart`: miniatura e reprodução no WhatsApp.
  - Até 1280 px no maior lado e até 30 fps.
  - Bitrate calculado pela duração para caber em 15 MB, com teto de 2,5 Mbps e piso de 350 kbps. Abaixo do piso o vídeo é recusado ("longo demais", ~4 min).
  - `-maxrate` igual ao bitrate segura picos.
- **Imagem:** `rotate()` aplica a orientação EXIF, `flatten` branco porque JPEG não tem transparência, até 1600 px, qualidade 80.
- **Limites do WhatsApp conferidos na saída:** 5 MB para imagem e 16 MB para vídeo. A dashboard confere de novo no bucket.
- **Erros:** só `ErroMidia` leva mensagem ao usuário, em português e acionável. Qualquer outro erro vira mensagem genérica e o detalhe fica só no log.
- **Processos:** sempre `spawn` sem shell, com argumentos em array, e com timeout.

## Segurança

- O token é de uso único (`tokensUsados`) e cada conversão só é visível para o `jti` que a criou (404 para os outros).
- Cada segredo de `SEGREDOS_TOKEN` precisa de 32+ caracteres. Com segredo curto ou com o placeholder do schema, o worker não sobe.
- `destino_url` vem dentro do token assinado. `DESTINOS_PERMITIDOS` é a segunda barreira contra SSRF; vazio desliga o modo destino.
- CORS só ecoa origens de `CORS_ORIGENS`.
- **Logs:** só id da conversão, tempos e o fim do stderr do ffmpeg. Nunca token, segredo, `destino_url` (tem assinatura) nem conteúdo de arquivo.
- Respostas de erro HTTP não expõem stack nem mensagens internas (`ErroHttp` ou "Erro interno").

## Decisões de arquitetura

- **Uma conversão por vez** (fila em `conversoes.mjs`): o ffmpeg usa toda a CPU que encontra, e o WAHA divide a máquina. O CPU limit do container fica no Easypanel.
- **Estado em memória:** num restart, as conversões em andamento somem, o status responde 404 e o cliente reenvia. Não adicionar banco nem Redis sem necessidade real.
- **Sem webhook:** o cliente consulta o status. Se um cliente servidor-a-servidor precisar de webhook, adicionar como opção no token, sem mudar o fluxo atual.
- **Sem credencial de bucket:** gravar no destino é sempre um PUT numa URL que o cliente assinou.

## Histórico de decisões

O projeto nasceu numa sessão com o Claude Code na dashboard, entre 2026-10-02 e 2026-10-05. Estas são as alternativas avaliadas e por que ficaram de fora. Não reabrir sem um fato novo.

- **`convert: true` do WAHA sozinho:** ele troca o codec com ffmpeg e costuma reduzir o arquivo (teste real: 12 MB → 5 MB). Mas não limita resolução nem bitrate, então vídeo longo ou 4K pode passar dos 16 MB. Também não converte imagem e roda a cada envio. Por isso a conversão é feita uma vez, no cadastro, e o envio usa `convert: false`. O nó n8n do WAHA (`n8n-nodes-waha` 2024.11.5) nem tem o campo `convert`: quem precisar dele chama a API por HTTP Request.
- **8mb.local** (template do Easypanel `jms1717/8mblocal`): converte vídeo bem, mas:
  - não trata imagem;
  - não grava em destino e não tem webhook;
  - só tem Basic Auth com senha fixa, que ficaria exposta no browser;
  - a interface dele mostra o histórico e os arquivos de todos.
- **Converter na Vercel:** limite de 4,5 MB no corpo, timeout e falta de ffmpeg.
- **Fluxo assíncrono com callback para a dashboard** (status "processando" na tabela, Reprocessar, migration): foi implementado e revertido. O usuário prefere que o registro só exista com o arquivo pronto e não quer consulta periódica na página. Hoje o browser espera no dialog, com progresso.
- **Repositório separado da dashboard:** o deploy é independente, e push na dashboard não reinicia o worker.
- **Deploy por schema com origem GitHub:** escolhido em vez de imagem publicada no GHCR ou template oficial do Easypanel, para não precisar publicar nada.
- **Escopo só WhatsApp:** perfis (`web-hd`, voz OGG/Opus etc.) ficam para quando houver um segundo uso real.
- **Contexto do WAHA:** vídeo na engine WEBJS exige a imagem `devlikeapro/waha:chrome`. A engine GOWS foi cogitada (gasta menos CPU), mas a troca depende de testar os webhooks do n8n. Botões não funcionam em nenhuma engine; a alternativa é enquete (`sendPoll`).

## Estado em 2026-10-05

- **Testado localmente** (Windows, ffmpeg 6.1):
  - HEVC 10-bit 1080x1920 60 fps, 22 MB → H.264 main 720x1280 30 fps + AAC, 9,8 MB, em 3 s.
  - Vídeo de 4,5 min → 15,7 MB. Vídeo de 6,6 min é recusado.
  - PNG transparente 4000x3000 → JPEG com fundo branco.
  - Arquivo corrompido gera a mensagem certa.
  - Todos os erros HTTP do README, CORS e preflight.
  - Token gerado pelo `lib/media-worker.ts` da dashboard → PUT no destino.
- **Não testado:** build da imagem Alpine, deploy no Easypanel e o fluxo pela tela da dashboard.
- **Pendências de deploy:**
  - criar o git e fazer o push;
  - colar o `easypanel-schema.json` com o segredo real;
  - limite de CPU em Advanced (a unidade do campo `cpuLimit` do schema não foi confirmada, por isso está 0);
  - conferir o `readTimeout` do Traefik para uploads grandes (padrão de 60 s na v3);
  - na Vercel, `MEDIA_WORKER_URL` e `MEDIA_WORKER_SEGREDO`.

## Princípios de desenvolvimento

- Código, nomes, mensagens e comentários em português, no estilo do código existente.
- Clean code: sem duplicação e sem lógica desnecessária. Comentário só para o "porquê" que não é evidente.
- Preferir a solução mais simples que resolve. Não antecipar recursos (perfis além do WhatsApp, multi-tenant, fila persistente) antes de existir uso real.

## Desenvolvimento e testes

- Rodar: `npm install` e depois `SEGREDOS_TOKEN=<32+ chars> CORS_ORIGENS=http://localhost:3000 npm start`. Precisa de `ffmpeg` e `ffprobe` no `PATH`. No Windows, os binários dos pacotes npm `ffmpeg-static` e `ffprobe-static` servem.
- Não há suíte de testes automatizados. Valide de ponta a ponta com o servidor rodando:
  - Gere um token com o exemplo do README.
  - Crie fixtures com o ffmpeg, por exemplo `-f lavfi -i testsrc2=size=1080x1920:rate=60 -c:v libx265 -pix_fmt yuv420p10le` para simular o HEVC do iPhone.
  - Confira a saída com `ffprobe` (codec, perfil, resolução, fps, `pix_fmt`, tamanho).
  - Cubra os erros: token inválido ou reusado, formato, tamanho, destino proibido, arquivo corrompido, vídeo longo, CORS.
- O `Dockerfile` usa `node:22-alpine`. A versão do ffmpeg da imagem pode diferir da local, então mudanças em parâmetros do ffmpeg precisam ser testadas no container.
