"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";

export default function NewProjectPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [clientName, setClientName] = useState("");
  const [description, setDescription] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api.createProject({
        name: name.trim(),
        client_name: clientName.trim() || null,
        description: description.trim() || null,
      }),
    onSuccess: (p) => {
      toast.success(`Created "${p.name}"`);
      qc.invalidateQueries({ queryKey: ["projects"] });
      router.push(`/projects/${p.id}`);
    },
    onError: (e: Error) => {
      toast.error(`Failed: ${e.message}`);
    },
  });

  return (
    <Card className="mx-auto max-w-xl">
      <CardHeader>
        <CardTitle>New project</CardTitle>
        <CardDescription>
          A project is a workspace for one process engagement.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            create.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="name">Name *</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Accounts Payable Process"
              required
              maxLength={200}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="client">Client</Label>
            <Input
              id="client"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              placeholder="ACME Industries"
              maxLength={200}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional notes about scope, stakeholders, or goals."
              rows={4}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => router.back()}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending ? "Creating…" : "Create project"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
