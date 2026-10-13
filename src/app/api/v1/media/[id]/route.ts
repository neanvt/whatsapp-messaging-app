import { NextResponse } from "next/server";
import { createClient } from "@libsql/client";

function getClient() {
  const url = process.env.TURSO_DATABASE_URL!;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  return createClient({ url, authToken });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "Missing ID" }, { status: 400 });
    }

    const client = getClient();
    const result = await client.execute({
      sql: "SELECT mimeType, filename, dataBase64 FROM MediaStore WHERE id = ?",
      args: [id],
    });

    if (!result.rows || result.rows.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const row = result.rows[0];
    const mimeType = String(row.mimeType || "application/pdf");
    const filename = String(row.filename || "document.pdf");
    const dataBase64 = String(row.dataBase64 || "");

    const buffer = Buffer.from(
      dataBase64.replace(/^data:[^;]+;base64,/, ""),
      "base64",
    );

    return new Response(buffer, {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
