import type { ReactNode } from "react";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { cn } from "@/lib/utils";

function FormField({
  htmlFor,
  label,
  description,
  error,
  className,
  children,
}: {
  htmlFor?: string;
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const invalid = error != null && error !== false;

  return (
    <Field data-invalid={invalid || undefined} className={cn("gap-2", className)}>
      <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
      {children}
      {description ? <FieldDescription className="text-xs">{description}</FieldDescription> : null}
      {invalid ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}

export { FormField };
