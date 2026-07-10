"use client";

import { X } from "lucide-react";
import { useEffect, useRef } from "react";

export function BookingModal({
  open,
  onClose
}: {
  open: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog className="booking-dialog" ref={dialogRef} onClose={onClose}>
      <div className="booking-dialog-head">
        <div>
          <strong>Book a discovery call</strong>
          <span>Choose a time that works for you.</span>
        </div>
        <button type="button" onClick={onClose} aria-label="Close booking calendar">
          <X size={22} aria-hidden="true" />
        </button>
      </div>
      <iframe
        title="Book a Launch Club discovery call"
        src="https://app.cal.com/launchclubai/discovery-call/embed?layout=month_view&theme=dark&useSlotsViewOnSmallScreen=true&embedType=inline&embed=discovery-call"
        allow="payment"
      />
    </dialog>
  );
}
