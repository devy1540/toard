"use client";

import { useTranslations } from "next-intl";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { revokeTokenAction } from "./token-actions";

export type TokenManagementRow = {
  id: string;
  label: string | null;
  lastHost: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

export function TokenManagementPanel({ tokens }: { tokens: TokenManagementRow[] }) {
  const t = useTranslations("settings");

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>{t("install.tokensTitle")}</CardTitle>
        <CardDescription>{t("install.tokensDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0">
        {tokens.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("install.tokenLabel")}</TableHead>
                <TableHead>{t("install.tokenLastHost")}</TableHead>
                <TableHead>{t("install.tokenCreated")}</TableHead>
                <TableHead>{t("install.tokenLastUsed")}</TableHead>
                <TableHead className="text-right">{t("install.tokenActions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((token) => (
                <TableRow key={token.id}>
                  <TableCell className="font-medium">
                    {token.label ?? t("install.tokenUnnamed")}
                  </TableCell>
                  <TableCell className={token.lastHost ? "" : "text-muted-foreground"}>
                    {token.lastHost ?? t("install.tokenNoHost")}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{token.createdAt}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {token.lastUsedAt ?? t("install.tokenNeverUsed")}
                  </TableCell>
                  <TableCell className="text-right">
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button type="button" variant="outline" size="sm">
                          {t("install.revokeToken")}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t("install.revokeTokenTitle")}</AlertDialogTitle>
                          <AlertDialogDescription>
                            {t("install.revokeTokenDescription", {
                              label: token.label ?? token.lastHost ?? t("install.tokenUnnamed"),
                            })}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t("install.revokeTokenCancel")}</AlertDialogCancel>
                          <form action={revokeTokenAction}>
                            <input type="hidden" name="tokenId" value={token.id} />
                            <AlertDialogAction type="submit" variant="destructive">
                              {t("install.revokeTokenConfirm")}
                            </AlertDialogAction>
                          </form>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-muted-foreground text-sm">{t("install.noTokens")}</p>
        )}
      </CardContent>
    </Card>
  );
}
