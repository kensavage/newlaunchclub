"use client";

import { useState } from "react";
import { BookingModal } from "@/components/booking-modal";

export function BookCallButton({
  children = "Book A Call",
  className = "internal-green-button"
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className={className} type="button" onClick={() => setOpen(true)}>
        {children}
      </button>
      {open ? <BookingModal open={open} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
