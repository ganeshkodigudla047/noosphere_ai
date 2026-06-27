import { pdfjs } from "react-pdf";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { StoredPage } from "./materialStore";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

export type PdfIndexProgress = {
  phase: "extracting" | "ocr";
  page: number;
  pageCount: number;
  progress?: number;
};

const API_BASE = (import.meta as any).env?.VITE_API_URL ?? "http://127.0.0.1:8000";

/**
 * Extract text from a PDF.
 *
 * Strategy:
 * 1. Try pdfjs native text extraction (fast, works for digital PDFs).
 * 2. For pages with no selectable text (scanned / handwritten), call the
 *    backend /ocr/pdf endpoint which uses PyMuPDF at 300 DPI + OpenCV
 *    preprocessing + GPT-4o Vision — far superior to Tesseract.js.
 */
export async function extractPdfPages(
  file: Blob,
  onProgress?: (status: PdfIndexProgress) => void,
): Promise<StoredPage[]> {
  const data = await file.arrayBuffer();
  const document = await pdfjs.getDocument({ data }).promise;
  const pages: StoredPage[] = [];
  const lowTextPages: number[] = [];

  // Pass 1: native text extraction
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    onProgress?.({ phase: "extracting", page: pageNumber, pageCount: document.numPages });
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = normalizeText(
      content.items.map((item) => ("str" in item ? item.str : "")).join(" "),
    );
    pages.push({ pageNumber, text, title: derivePageTitle(text, pageNumber) });
    if (text.length < 30) {
      lowTextPages.push(pageNumber);
    }
  }

  // Pass 2: backend OCR for pages with no selectable text
  if (lowTextPages.length > 0) {
    try {
      onProgress?.({
        phase: "ocr",
        page: lowTextPages[0]!,
        pageCount: document.numPages,
        progress: 0,
      });

      const formData = new FormData();
      formData.append("file", file, (file as File).name ?? "material.pdf");
      formData.append("page_numbers", lowTextPages.join(","));

      const response = await fetch(`${API_BASE}/ocr/pdf`, {
        method: "POST",
        body: formData,
      });

      if (response.ok) {
        const result = await response.json();
        const ocrByPage: Record<number, string> = {};
        for (const p of result.pages ?? []) {
          if (p.markdown && !p.markdown.startsWith("[OCR failed")) {
            ocrByPage[p.page_number] = normalizeText(p.markdown);
          }
        }

        for (let i = 0; i < pages.length; i++) {
          const p = pages[i]!;
          if (ocrByPage[p.pageNumber]) {
            const ocrText = ocrByPage[p.pageNumber]!;
            pages[i] = {
              pageNumber: p.pageNumber,
              text: ocrText,
              title: derivePageTitle(ocrText, p.pageNumber),
            };
            onProgress?.({
              phase: "ocr",
              page: p.pageNumber,
              pageCount: document.numPages,
              progress: lowTextPages.indexOf(p.pageNumber) / lowTextPages.length,
            });
          }
        }
      }
    } catch {
      // Backend OCR failed — pages keep whatever text was extracted natively
    }
  }

  return pages;
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
