"use client"

import { ExternalLink, Loader2 } from "lucide-react"
import { useActionState } from "react"
import { toast } from "sonner"

import { connectGmailAction, type ConnectGmailState } from "@/app/(dashboard)/settings/actions"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

export function GmailConnectForm({
  defaultEmail,
  lockEmail = false,
  onDone,
}: {
  defaultEmail: string
  /** When updating the password of an existing connection. */
  lockEmail?: boolean
  onDone?: () => void
}) {
  const [state, formAction, pending] = useActionState(
    async (prev: ConnectGmailState, formData: FormData) => {
      const result = await connectGmailAction(prev, formData)
      if (result.status === "success") {
        toast.success(`Connected ${result.email}.`)
        onDone?.()
      }
      return result
    },
    { status: "idle" }
  )

  const errors = state.status === "error" ? state.fieldErrors : undefined
  const email = state.status === "error" && state.email ? state.email : defaultEmail

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>Turn on 2-Step Verification for your Google account (app passwords need it).</li>
        <li>
          Create an app password named “MailBrain” at{" "}
          <a
            href="https://myaccount.google.com/apppasswords"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4"
          >
            Google app passwords
            <ExternalLink className="size-3" aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
          .
        </li>
        <li>Paste the 16-letter password below.</li>
      </ol>

      {state.status === "error" && state.message && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      <FieldGroup>
        <Field data-invalid={Boolean(errors?.email)}>
          <FieldLabel htmlFor="gmail-email">Gmail address</FieldLabel>
          <Input
            id="gmail-email"
            name="email"
            type="email"
            autoComplete="email"
            defaultValue={email}
            readOnly={lockEmail}
            aria-invalid={Boolean(errors?.email)}
            required
          />
          <FieldError errors={errors?.email ? [{ message: errors.email }] : undefined} />
        </Field>

        <Field data-invalid={Boolean(errors?.appPassword)}>
          <FieldLabel htmlFor="gmail-app-password">App password</FieldLabel>
          <Input
            id="gmail-app-password"
            name="appPassword"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="abcd efgh ijkl mnop"
            aria-invalid={Boolean(errors?.appPassword)}
            required
          />
          <FieldDescription>
            Stored encrypted and only used to read and label your email. Not your Google password.
          </FieldDescription>
          <FieldError errors={errors?.appPassword ? [{ message: errors.appPassword }] : undefined} />
        </Field>
      </FieldGroup>

      <div>
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          {pending ? "Checking with Gmail…" : lockEmail ? "Update app password" : "Connect Gmail"}
        </Button>
      </div>
    </form>
  )
}
