"use client";

import { Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import type { NodeAIEditResponse, UUID } from "@/lib/types";

export function AIEditModal({
  open,
  projectId,
  nodeId,
  currentLabel,
  onClose,
  onApply,
}: {
  open: boolean;
  projectId: UUID;
  nodeId: UUID;
  currentLabel: string;
  onClose: () => void;
  /** Called with the AI-suggested label when the user clicks Apply. */
  onApply: (newLabel: string) => Promise<void> | void;
}) {
  const [instruction, setInstruction] = useState("");
  const [suggestion, setSuggestion] = useState<NodeAIEditResponse | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Reset state every time the modal is reopened (or aimed at a new node).
  useEffect(() => {
    if (open) {
      setInstruction("");
      setSuggestion(null);
      // Defer focus so the dialog has a chance to mount first.
      const t = window.setTimeout(() => inputRef.current?.focus(), 50);
      return () => window.clearTimeout(t);
    }
  }, [open, nodeId]);

  const suggestMutation = useMutation({
    mutationFn: () =>
      api.aiSuggestNodeEdit(projectId, nodeId, {
        instruction: instruction.trim(),
      }),
    onSuccess: (data) => setSuggestion(data),
  });

  const handleSubmit = () => {
    if (!instruction.trim() || suggestMutation.isPending) return;
    setSuggestion(null);
    suggestMutation.mutate();
  };

  const handleApply = async () => {
    if (!suggestion) return;
    await onApply(suggestion.suggested_label);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles size={16} className="text-slate-700" />
            Ask AI to edit this step
          </DialogTitle>
          <DialogDescription>
            Describe how you want this label rewritten — e.g. &quot;make it
            clearer&quot;, &quot;match SOP wording&quot;, &quot;shorten it&quot;.
            The model uses the linked claims as context and proposes a single
            label change you can apply.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Current label
            </div>
            <div className="mt-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm text-slate-700">
              {currentLabel || "(empty)"}
            </div>
          </div>

          <div>
            <label
              htmlFor="ai-instruction"
              className="text-[10px] font-semibold uppercase tracking-wide text-slate-500"
            >
              Instruction
            </label>
            <textarea
              id="ai-instruction"
              ref={inputRef}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              placeholder="What should the AI change about this label?"
              rows={3}
              className="mt-1 w-full resize-none rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
            />
            <div className="mt-1 text-[10px] text-slate-400">
              ⌘/Ctrl + Enter to submit
            </div>
          </div>

          {suggestMutation.isError && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1.5 text-xs text-rose-700">
              {(suggestMutation.error as Error).message}
            </div>
          )}

          {suggestion && (
            <div className="space-y-2 rounded-md border border-indigo-200 bg-indigo-50/60 px-3 py-2">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-indigo-700">
                  Proposed label
                </div>
                <div className="mt-1 text-sm font-medium text-slate-900">
                  {suggestion.suggested_label}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-indigo-700">
                  Rationale
                </div>
                <div className="mt-1 text-[12px] leading-snug text-slate-700">
                  {suggestion.rationale}
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {suggestion ? (
            <>
              <Button variant="outline" onClick={() => setSuggestion(null)}>
                Try again
              </Button>
              <Button onClick={handleApply}>Apply label</Button>
            </>
          ) : (
            <Button
              onClick={handleSubmit}
              disabled={!instruction.trim() || suggestMutation.isPending}
            >
              {suggestMutation.isPending ? "Thinking…" : "Get suggestion"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
