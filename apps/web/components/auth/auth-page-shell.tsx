import type { ReactNode } from "react";
import { LogoMark } from "@/components/logo-mark";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

function AuthPageShell({
  title,
  description,
  children,
  contentClassName,
}: {
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
  contentClassName?: string;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <LogoMark size={32} className="mb-1" />
          <CardTitle className="text-xl">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        {children ? <CardContent className={cn(contentClassName)}>{children}</CardContent> : null}
      </Card>
    </main>
  );
}

export { AuthPageShell };
