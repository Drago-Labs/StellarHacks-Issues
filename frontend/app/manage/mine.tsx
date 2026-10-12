"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { hackathonsRun, type Organized } from "../../lib/organized";
import { phaseName } from "../../lib/phase";
import { useWallet } from "../components/wallet-context";

/**
 * The way back into an event somebody is running.
 *
 * There was none. `/manage/[contract]` was keyed on a contract address for a
 * good reason, that an event exists on chain before anybody has typed a name for
 * it, and the cost of that was an organizer who had to keep the address
 * somewhere themselves. Everything the product asks them to do afterwards, the
 * approvals, the lock, the reveal, lives behind an address in their clipboard.
 *
 * Read on the client and keyed by the connected wallet, for the reason the
 * joined list is: which address is connected is a fact about the browser, and
 * the server rendering this has no way to know it and must not guess.
 */

export function Mine({
  organizer,
  described,
  children,
}: {
  /** The address the server rendered the cards for, from the page's address. */
  organizer: string | null;
  /** The events among those cards, so a draft is not listed twice. */
  described: string[];
  /** The cards, drawn on the server the way the public list draws them. */
  children: React.ReactNode;
}) {
  const { wallet, known } = useWallet();
  const router = useRouter();
  const [list, setList] = useState<Organized[] | null>(null);

  const address = wallet?.address ?? null;

  /* The cards are for whichever wallet is connected now. A wallet swapped while
     the page is open asks the server again for the other one's. */
  useEffect(() => {
    if (address !== null && address !== organizer) {
      router.replace(`/manage?organizer=${address}`);
    }
  }, [address, organizer, router]);

  useEffect(() => {
    if (address === null) {
      setList(null);
      return;
    }

    let current = true;

    void hackathonsRun(address).then((found) => {
      if (current) {
        setList(found);
      }
    });

    /* A wallet swapped mid read would otherwise put one organizer's events
       under another organizer's address. */
    return () => {
      current = false;
    };
  }, [address]);

  if (!known || address === null) {
    return (
      <Empty>
        {known
          ? "Connect the wallet you created them with. An event belongs to the key that signed it, not to the account."
          : "Looking for a wallet."}
      </Empty>
    );
  }

  if (address !== organizer || list === null) {
    return <Empty>Reading the chain.</Empty>;
  }

  /* An event with no page yet has no card to draw, and it is exactly the one
     somebody just created and came here to get back to. */
  const drafts = list.filter((entry) => !described.includes(entry.contractId));

  if (described.length === 0 && drafts.length === 0) {
    return (
      <Empty>
        This address has not created a hackathon yet.{" "}
        <Link href="/create" className="text-ink underline underline-offset-4">
          Create one
        </Link>
        .
      </Empty>
    );
  }

  return (
    <div className="grid gap-10">
      {children}

      {drafts.length > 0 && (
        <ul className="border-t border-rule">
          {drafts.map((entry) => (
            <li key={entry.contractId}>
              <Link
                href={`/manage/${entry.contractId}`}
                className="flex items-center gap-4 border-b border-rule py-4 transition-colors duration-150 ease-settle hover:bg-paper-sunk"
              >
                <span aria-hidden className="size-9 shrink-0 rounded-[0.35rem] bg-paper-sunk ring-1 ring-rule" />

                <span className="min-w-0 flex-1 truncate tabular text-[0.9375rem] text-ink-soft">
                  {entry.name ?? entry.contractId}
                </span>

                <span className="label shrink-0 text-ink-faint">{phaseName(entry.phase)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-t border-rule pt-5 text-[0.9375rem] leading-relaxed text-ink-soft">
      {children}
    </p>
  );
}
