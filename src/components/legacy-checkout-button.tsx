"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function LegacyCheckoutButton({
  plan,
  price,
  features,
  href,
  children,
  className = "pricing-button"
}: {
  plan: string;
  price: string;
  features: readonly string[];
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) dialog.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);

  return (
    <>
      <button className={className} type="button" onClick={() => setOpen(true)}>
        {children}
      </button>
      <dialog className="checkout-dialog" ref={dialogRef} onClose={() => setOpen(false)}>
        <button
          className="dialog-close"
          type="button"
          aria-label="Close"
          onClick={() => setOpen(false)}
        >
          <X size={22} aria-hidden="true" />
        </button>
        <p className="internal-kicker">(Launch Club)</p>
        <h2>Start Subscription</h2>
        <p>
          You selected <strong>{plan}</strong>. Your secure subscription and account will be
          completed in the existing Launch Club checkout.
        </p>
        <strong className="checkout-price">{price}</strong>
        <ul>
          {features.slice(0, 5).map((feature) => (
            <li key={feature}>{feature}</li>
          ))}
        </ul>
        <a className="internal-green-button" href={href}>
          Continue to secure checkout
        </a>
      </dialog>
    </>
  );
}
