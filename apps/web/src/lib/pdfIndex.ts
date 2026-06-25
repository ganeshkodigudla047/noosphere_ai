import { pdfjs } from "react-pdf";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { createWorker, OEM, type Worker } from "tesseract.js";
import type { StoredPage } from "./materialStore";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

export type PdfIndexProgress = {
  phase: "extracting" | "ocr";
  page: number;
  pageCount: number;
  progress?: number;
};

export async function extractPdfPages(file: Blob, onProgress?: (status: PdfIndexProgress) => void): Promise<StoredPage[]> {
  const data = await file.arrayBuffer();
  const document = await pdfjs.getDocument({ data }).promise;
  const pages: StoredPage[] = [];
  let ocrWorker: Worker | undefined;
  let activeOcrPage = 1;

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      onProgress?.({ phase: "extracting", page: pageNumber, pageCount: document.numPages });
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      let text = normalizeText(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));

      if (text.length < 24) {
        activeOcrPage = pageNumber;
        onProgress?.({ phase: "ocr", page: pageNumber, pageCount: document.numPages, progress: 0 });
        ocrWorker ??= await createWorker("eng", OEM.LSTM_ONLY, {
          logger: (message) => {
            if (message.status === "recognizing text") {
              onProgress?.({ phase: "ocr", page: activeOcrPage, pageCount: document.numPages, progress: message.progress });
            }
          }
        });
        const viewport = page.getViewport({ scale: 1.65 });
        const canvas = documentOwnerCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext("2d", { alpha: false });
        if (context) {
          await page.render({ canvas, canvasContext: context, viewport }).promise;
          const result = await ocrWorker.recognize(canvas);
          text = normalizeText(result.data.text);
        }
      }

      pages.push({ pageNumber, text, title: derivePageTitle(text, pageNumber) });
    }
  } finally {
    await ocrWorker?.terminate();
  }

  return pages;
}

function documentOwnerCanvas(width: number, height: number) {
  const canvas = window.document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function derivePageTitle(text: string, pageNumber: number) {
  if (!text) return `Page ${pageNumber}`;
  const sentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
  const words = sentence.split(" ").slice(0, 9).join(" ");
  return words.length > 72 ? `${words.slice(0, 69)}…` : words;
}
