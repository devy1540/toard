import type { ReactNode } from "react";
import { Info } from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";

function LibraryNotice({ title, description }: { title: ReactNode; description: ReactNode }) {
  return (
    <Alert className="border-sky-500/30 bg-sky-500/5">
      <Info className="text-sky-600 dark:text-sky-400" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  );
}

export { LibraryNotice };
