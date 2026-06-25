import { useEffect, useRef, useState } from "react";
import { Document, Page } from "react-pdf";
import "../lib/pdfIndex";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

export function PdfReader({ source, title, initialPage = 1 }: { source: string; title: string; initialPage?: number }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [pageCount, setPageCount] = useState(0);

  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, Math.min(860, entry.contentRect.width - 32)));
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!pageCount) return;
    const timer = window.setTimeout(() => {
      container.current?.querySelector(`[data-page="${initialPage}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [initialPage, pageCount]);

  return <div className="pdf-reader" ref={container}>
    <Document
      file={source}
      onLoadSuccess={({ numPages }) => setPageCount(numPages)}
      loading={<PdfStatus title={`Opening ${title}…`} />}
      error={<PdfStatus title="This PDF could not be rendered." detail="Try uploading the file again or use a PDF without password protection." />}
    >
      {Array.from({ length: pageCount }, (_, index) => (
        <section className="pdf-page" data-page={index + 1} key={`page-${index + 1}`} aria-label={`Page ${index + 1}`}>
          <span className="pdf-page-number">{index + 1}</span>
          <Page pageNumber={index + 1} width={width} loading={<PdfStatus title={`Loading page ${index + 1}…`} />} />
        </section>
      ))}
    </Document>
  </div>;
}

function PdfStatus({ title, detail }: { title: string; detail?: string }) {
  return <div className="pdf-status"><span className="pdf-spinner" /><strong>{title}</strong>{detail && <small>{detail}</small>}</div>;
}
