import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import sharp from "sharp";
import { preprocessDocument } from "../src/services/document-preprocessor.js";

describe("document preprocessing", () => {
  it("removes only structurally empty PDF pages, chunks to five pages, and retains original page numbers", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let index = 0; index < 8; index += 1) {
      const page = pdf.addPage();
      if (index !== 2) page.drawText(`Invoice page ${index + 1}`, { x: 30, y: 700, font });
    }
    const prepared = await preprocessDocument(new File([Buffer.from(await pdf.save())], "invoice.pdf", { type: "application/pdf" }));
    expect(prepared.map((part) => part.originalPages)).toEqual([[1, 2, 4, 5, 6], [7, 8]]);
    expect(await Promise.all(prepared.map(async (part) => (await PDFDocument.load(await part.file.arrayBuffer())).getPageCount()))).toEqual([5, 2]);
  });

  it("normalizes large images to bounded JPEG input without enlargement", async () => {
    const source = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: "white" } }).png().toBuffer();
    const [prepared] = await preprocessDocument(new File([source], "invoice.png", { type: "image/png" }));
    const metadata = await sharp(Buffer.from(await prepared!.file.arrayBuffer())).metadata();
    expect(prepared!.file.type).toBe("image/jpeg");
    expect(metadata.width).toBe(2048);
    expect(metadata.height).toBeLessThanOrEqual(2048);
  });

  it("rejects PDFs with no processable pages", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    await expect(preprocessDocument(new File([Buffer.from(await pdf.save())], "blank.pdf", { type: "application/pdf" }))).rejects.toThrow("no processable pages");
  });
});
