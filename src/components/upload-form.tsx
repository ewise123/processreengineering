"use client";

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { INPUT_TYPES, type UUID } from "@/lib/types";

const TYPE_LABELS: Record<string, string> = {
  interview_transcript: "Interview transcript",
  interview_notes: "Interview notes",
  sop_document: "SOP document",
  operating_manual: "Operating manual / playbook",
  process_map_upload: "Process map upload",
  event_log: "Event log",
  observation_notes: "Observation notes",
  meeting_minutes: "Meeting minutes / transcript",
  strategy_document: "Strategy document",
  organizational_chart: "Organizational chart",
  role_description: "Role description",
  policy_document: "Policy document",
  sla_agreement: "SLA agreement",
  operational_dashboard: "Operational dashboard",
  governance_charter: "Governance charter",
  business_requirements: "Business requirements",
  email_thread: "Email thread",
  transaction_data: "Transaction / event data",
  vendor_procedure: "Vendor procedure",
  audio_file: "Audio file",
};

interface UploadResult {
  inputId: UUID;
  filename: string;
  parseError: string | null;
}

export function UploadForm({ projectId }: { projectId: UUID }) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<string>("sop_document");
  const [file, setFile] = useState<File | null>(null);

  const resetSelection = () => {
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const upload = useMutation<UploadResult, Error>({
    mutationFn: async () => {
      if (!file) throw new Error("No file selected");
      // Step 1: upload (creates the input row, persists the file)
      const inp = await api.uploadInput(projectId, type, file);
      // Step 2: parse (separate try so we can report partial success)
      let parseError: string | null = null;
      try {
        await api.parseInput(projectId, inp.id);
      } catch (err) {
        parseError = err instanceof Error ? err.message : String(err);
      }
      return { inputId: inp.id, filename: inp.name, parseError };
    },
    onSuccess: (result) => {
      // Either way, the input row exists — refresh the list
      qc.invalidateQueries({ queryKey: ["inputs", projectId] });
      if (result.parseError) {
        toast.error(
          `Uploaded ${result.filename}, but parsing failed: ${result.parseError}. Retry parse from the Documents tab.`
        );
      } else {
        toast.success(`Uploaded & parsed ${result.filename}`);
      }
      setOpen(false);
      resetSelection();
    },
    onError: (e) => toast.error(`Upload failed: ${e.message}`),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) resetSelection();
      }}
    >
      <DialogTrigger asChild>
        <Button>Upload document</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload document</DialogTitle>
          <DialogDescription>
            File is parsed into sections + chunks immediately. Embeddings and
            claim extraction run separately.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="file">File</Label>
            <input
              ref={fileRef}
              id="file"
              type="file"
              accept=".pdf,.docx,.pptx,.xlsx,.txt,.md"
              className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <p className="text-xs text-muted-foreground">
              PDF, DOCX, PPTX, XLSX, TXT, MD — 50 MB max.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="type">Type</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger id="type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INPUT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TYPE_LABELS[t] ?? t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              resetSelection();
              setOpen(false);
            }}
            disabled={upload.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => upload.mutate()}
            disabled={!file || upload.isPending}
          >
            {upload.isPending ? "Uploading…" : "Upload & parse"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
