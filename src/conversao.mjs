import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const MB = 1024 * 1024;

/** O que o worker aceita. A saída é sempre JPEG (imagem) ou MP4 (vídeo). */
export const FORMATOS_ENTRADA = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

const IMAGEM = { lado: 1600, qualidade: 80, limiteBytes: 5 * MB };

const VIDEO = {
  lado: 1280,
  fps: 30,
  // Margem sob os 16 MB do WhatsApp: o bitrate médio oscila um pouco.
  alvoBytes: 15 * MB,
  limiteBytes: 16 * MB,
  bitrateAudio: 96_000,
  bitrateMaximo: 2_500_000,
  // Abaixo disso o vídeo em 720p fica borrado demais para valer o envio.
  bitrateMinimo: 350_000,
  timeoutMs: 15 * 60 * 1000,
};

const DURACAO_MAXIMA_MIN = Math.floor(
  (VIDEO.alvoBytes * 8) / (VIDEO.bitrateMinimo + VIDEO.bitrateAudio) / 60,
);

/** Erro com mensagem para o usuário. Os demais viram mensagem genérica e só aparecem no log. */
export class ErroMidia extends Error {}

export function contentTypeDeSaida(contentTypeEntrada) {
  return contentTypeEntrada.startsWith("video/") ? "video/mp4" : "image/jpeg";
}

/**
 * Converte para o formato do WhatsApp dentro de `pasta`.
 * `aoProgredir` recebe 0–100 durante o vídeo; imagem é rápida demais para isso.
 * `aoInformar` recebe o que foi lido da entrada e os parâmetros escolhidos, para o log.
 */
export async function converterMidia(entrada, contentTypeEntrada, pasta, aoProgredir, aoInformar = () => {}) {
  const contentType = contentTypeDeSaida(contentTypeEntrada);
  const ehVideo = contentType === "video/mp4";
  const caminho = join(pasta, ehVideo ? "saida.mp4" : "saida.jpg");

  if (ehVideo) await converterVideo(entrada, caminho, aoProgredir, aoInformar);
  else await converterImagem(entrada, caminho, aoInformar);

  const { size } = await stat(caminho);
  const limite = ehVideo ? VIDEO.limiteBytes : IMAGEM.limiteBytes;
  if (size > limite) {
    throw new ErroMidia(
      `O arquivo convertido passou de ${limite / MB} MB. Envie ${ehVideo ? "um vídeo mais curto" : "outra imagem"}`,
    );
  }

  return { caminho, contentType, tamanho: size };
}

async function converterImagem(entrada, saida, aoInformar) {
  try {
    const { format, width, height } = await sharp(entrada).metadata();
    aoInformar(`imagem de entrada: ${format}, ${width}x${height}`);
    await sharp(entrada)
      // Aplica a orientação EXIF: sem isso foto de celular chega deitada.
      .rotate()
      .resize({
        width: IMAGEM.lado,
        height: IMAGEM.lado,
        fit: "inside",
        withoutEnlargement: true,
      })
      // JPEG não tem transparência: PNG transparente ganha fundo branco em vez de preto.
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: IMAGEM.qualidade, mozjpeg: true })
      .toFile(saida);
  } catch (erro) {
    throw new ErroMidia("Não foi possível ler a imagem. O arquivo pode estar corrompido", {
      cause: erro,
    });
  }
}

/**
 * H.264 + AAC é o único formato que o WhatsApp toca em todo aparelho (vídeo de
 * iPhone vem em HEVC). O bitrate sai da duração para o arquivo caber nos 16 MB.
 */
async function converterVideo(entrada, saida, aoProgredir, aoInformar) {
  const { duracao, largura, altura, codec } = await lerVideo(entrada);
  const bitrate = Math.min(
    VIDEO.bitrateMaximo,
    Math.floor((VIDEO.alvoBytes * 8) / duracao - VIDEO.bitrateAudio),
  );
  aoInformar(
    `vídeo de entrada: ${codec ?? "codec ?"}, ${largura ?? "?"}x${altura ?? "?"}, ${duracao.toFixed(1)} s; saída até ${VIDEO.lado} px a ${(bitrate / 1e6).toFixed(2)} Mbps`,
  );

  if (bitrate < VIDEO.bitrateMinimo) {
    throw new ErroMidia(
      `Vídeo longo demais para o WhatsApp: o máximo é de cerca de ${DURACAO_MAXIMA_MIN} min`,
    );
  }

  await executar(
    "ffmpeg",
    [
      "-y", "-v", "error", "-nostats", "-progress", "pipe:1", "-i", entrada,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "main", "-pix_fmt", "yuv420p",
      "-vf", `scale=w='min(${VIDEO.lado},iw)':h='min(${VIDEO.lado},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
      "-fpsmax", String(VIDEO.fps),
      "-b:v", String(bitrate), "-maxrate", String(bitrate), "-bufsize", String(bitrate * 2),
      "-c:a", "aac", "-b:a", String(VIDEO.bitrateAudio), "-ac", "2",
      // faststart põe o índice no início: o WhatsApp gera a miniatura e começa a tocar sem baixar tudo.
      "-movflags", "+faststart", "-map_metadata", "-1",
      saida,
    ],
    {
      timeout: VIDEO.timeoutMs,
      aoLerLinha: (linha) => {
        const [chave, valor] = linha.split("=");
        if (chave === "out_time_us" && Number(valor) > 0) {
          aoProgredir(Math.min(99, Math.round((Number(valor) / 1e6 / duracao) * 100)));
        }
      },
    },
  );
}

async function lerVideo(arquivo) {
  const saida = await executar("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "format=duration:stream=width,height,codec_name",
    "-of", "json",
    arquivo,
  ]).catch((erro) => {
    throw new ErroMidia("Não foi possível ler o vídeo. O arquivo pode estar corrompido", {
      cause: erro,
    });
  });

  let dados = {};
  try {
    dados = JSON.parse(saida);
  } catch {
    // Saída inesperada do ffprobe cai na checagem da duração logo abaixo.
  }
  const duracao = Number.parseFloat(dados.format?.duration);
  if (!(duracao > 0)) {
    throw new ErroMidia("Não foi possível ler a duração do vídeo");
  }
  const [video] = dados.streams ?? [];
  return { duracao, largura: video?.width, altura: video?.height, codec: video?.codec_name };
}

/** Roda sem shell (argumentos não passam por interpretação) e guarda só o fim do stderr para o log. */
function executar(comando, args, { timeout = 60_000, aoLerLinha } = {}) {
  return new Promise((resolve, reject) => {
    const processo = spawn(comando, args, { timeout, stdio: ["ignore", "pipe", "pipe"] });
    let saida = "";
    let erros = "";
    processo.stdout.on("data", (pedaco) => {
      saida += pedaco;
      if (!aoLerLinha) return;
      const linhas = saida.split("\n");
      saida = linhas.pop();
      linhas.forEach((linha) => aoLerLinha(linha.trim()));
    });
    processo.stderr.on("data", (pedaco) => {
      erros = (erros + pedaco).slice(-2000);
    });
    processo.on("error", reject);
    processo.on("close", (codigo, sinal) => {
      if (codigo === 0) resolve(saida);
      else reject(new Error(`${comando} falhou (${sinal ?? codigo}): ${erros}`));
    });
  });
}
