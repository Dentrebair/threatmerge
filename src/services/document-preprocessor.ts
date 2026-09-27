import { PDFDocument } from "pdf-lib";
import sharp from "sharp";

export interface PreparedDocument {
  file: File;
  originalPages: number[];
}

const PDF_CHUNK_PAGES = 5;
const MAX_IMAGE_DIMENSION = 2048;
const MAX_IMAGE_PIXELS = 40_000_000;

export async function preprocessDocument(file: File): Promise<PreparedDocument[]> {
  if (file.type === "application/pdf") return preprocessPdf(file);
  if (file.type === "image/jpeg" || file.type === "image/png") return [await preprocessImage(file)];
  throw new Error("unsupported preprocessing type");
}

async function preprocessPdf(file: File): Promise<PreparedDocument[]> {
  const source = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: false, updateMetadata: false });
  if (source.isEncrypted) throw new Error("password-protected PDFs are not supported");
  const retained = source.getPages().map((page, index) => ({ page, originalPage: index + 1 }))
    .filter(({ page }) => page.node.Contents() !== undefined);
  if (!retained.length) throw new Error("PDF contains no processable pages");
  const chunks: PreparedDocument[] = [];
  for (let offset = 0; offset < retained.length; offset += PDF_CHUNK_PAGES) {
    const selection = retained.slice(offset, offset + PDF_CHUNK_PAGES);
    const chunk = await PDFDocument.create();
    const copied = await chunk.copyPages(source, selection.map(({ originalPage }) => originalPage - 1));
    copied.forEach((page) => chunk.addPage(page));
    chunks.push({
      file: new File([Buffer.from(await chunk.save({ useObjectStreams: false }))], `${file.name || "invoice"}.part-${chunks.length + 1}.pdf`, { type: "application/pdf" }),
      originalPages: selection.map(({ originalPage }) => originalPage),
    });
  }
  return chunks;
}

async function preprocessImage(file: File): Promise<PreparedDocument> {
  const input = Buffer.from(await file.arrayBuffer());
  const pipeline = sharp(input, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "error" }).rotate();
  const metadata = await pipeline.metadata();
  if (!metadata.width || !metadata.height) throw new Error("image dimensions could not be read");
  const output = await pipeline.resize({ width: MAX_IMAGE_DIMENSION, height: MAX_IMAGE_DIMENSION, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85, chromaSubsampling: "4:4:4" }).toBuffer();
  return { file: new File([output], `${file.name || "invoice"}.normalized.jpg`, { type: "image/jpeg" }), originalPages: [1] };
}
