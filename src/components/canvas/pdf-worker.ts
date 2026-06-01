// src/components/canvas/pdf-worker.ts
// One-time pdf.js worker + text/annotation layer CSS setup for react-pdf.
// Importing this module (for its side effects) configures the worker so it
// works under Next.js Turbopack. Import it once from the viewer component.
import { pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();
