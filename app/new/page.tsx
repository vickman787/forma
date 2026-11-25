import { Suspense } from "react";
import { BriefForm } from "@/components/brief-form";
export default function Page() {
  return (
    <Suspense fallback={<p className="loading">Opening your studio…</p>}>
      <BriefForm />
    </Suspense>
  );
}
