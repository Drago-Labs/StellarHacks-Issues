import { BrandMascot } from "./brand-mascot";
import footerStyles from "./footer.module.css";
import { AccountMenu } from "./account-menu";
import { currentUser, serverClient } from "../../lib/supabase/server";
import { isStaff, mayOrganize } from "../../lib/organizing";
import { profileOf } from "../../lib/profile";

/**
 * The frame every page is read inside.
 *
 * Lives in the layout rather than in each page, because a header that a page
 * has to remember to include is a header some page will eventually forget.
 */

export async function Header() {
  const user = await currentUser();

  /* Only for the handle, which is what the menu's Profile row links to. A menu
     that had to guess the address would guess it wrong for anybody who has
     changed their username. */
  const db = user === null ? null : await serverClient();

  /* Three reads for one menu, asked together rather than one after another.
     The menu is on every page, so the difference between these being parallel
     and being sequential is two round trips added to every request in the
     product. */
  const [profile, organizer, staff] =
    db === null || user === null
      ? [null, false, false]
      : await Promise.all([profileOf(db, user.id), mayOrganize(db), isStaff(db)]);

  /* A sheet of glass across the top, curled off at the bottom two corners.

     It floated for a while: held off all four edges, hairlined the whole way
     round, four corners rounded. That shape is a card, and a card announces
     itself. What belongs up here is a surface the page passes behind, so the
     bar goes back to meeting the top and the sides, and the only drawn edge
     left is the one that has a job — the line the content stops at.

     That line is barely there on purpose. The bar is read as glass because
     the page is visible through it and blurred, not because an outline says
     where it ends; an edge you can see the weight of is the thing that turns
     glass back into a panel. The two bottom corners carry all the shape. */
  return (
    <>
      {/*
        The glass past the bar's own edge.

        The bar covers its own height and stops, and the two curled corners
        leave the page sharp in the notches beside them. This reaches lower
        than the bar and fades out rather than stopping on a line, so what is
        under the curls is blurred like everything above them and the corner
        reads as a shape cut in glass rather than a bite taken out of it.

        It sits under the header and over the page, and it takes no pointer
        events: it is a surface, not a control.
      */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 z-10 h-[5.75rem] backdrop-blur-xl [mask-image:linear-gradient(to_bottom,black_0,black_4.5rem,transparent_5.75rem)]"
      />

      {/* The height is stated on the header itself rather than on the row
          inside it, so the space this bar occupies is one number and not that
          number plus a hairline. The sign in page pulls its artwork up by
          exactly this much and the difference was two pixels of scrollbar. */}
      <header className="sticky top-0 z-20 h-18 rounded-b-[1.5rem] border-b border-rule/50 bg-paper/55 backdrop-blur-2xl backdrop-saturate-150">
      {/* A little wider than before, because the bar no longer holds itself off
          the window: the margin that used to come from the gap down each side
          has to come from the padding instead. */}
      <div className="mx-auto flex h-full w-full max-w-[96rem] items-center justify-between px-6 sm:px-8">
        <a href="/" className="flex items-center gap-2.5">
          {/* The mark ships on its own black tile rather than transparent. The
              art has a black laptop screen and a black shadow in it, so a
              cut out version loses half of itself the moment it lands on a
              dark surface. A square of night is a surface this system already
              uses, so the tile reads as deliberate in both colour schemes. */}
          <img
            src="/mark.png"
            alt=""
            width={44}
            height={44}
            className="size-11 rounded-[0.6rem]"
          />

          <span className="display text-[1.625rem] tracking-normal">StelHacks</span>
        </a>

        <nav className="hidden items-center gap-1 sm:flex" aria-label="Sections">
          {/* Beside the two public sections for whoever may start an event, the
              same grant the create page checks. On a phone, where this row is
              hidden, the account menu carries the same link. */}
          {[
            ["Hackathons", "/hackathons"],
            ["Statistics", "/statistics"],
            ...(organizer ? [["Management Panel", "/manage"]] : []),
          ].map(([label, href]) => (
            <a
              key={href}
              href={href}
              className="rounded-full px-4 py-2 text-[1.1875rem] font-semibold text-ink transition-colors duration-150 ease-settle hover:bg-paper-sunk"
            >
              {label}
            </a>
          ))}
        </nav>

        {/* The one control on the right, and it changes with the situation: a
            way in, then the person, then the connected address beside them.
            "Browse" used to sit here and said the same thing as the Hackathons
            link beside it. */}
        <AccountMenu
          email={user?.email ?? null}
          username={profile?.username ?? null}
          avatarUrl={profile?.avatarUrl ?? null}
          organizer={organizer}
          staff={staff}
        />
      </div>
      </header>
    </>
  );
}

export function Footer() {
  return (
    <footer className={footerStyles.footer}>
      <div className={footerStyles.card}>
        <div className={footerStyles.main}>
          <div>
            <a href="/" className={footerStyles.brand} aria-label="StelHacks home">
              <BrandMascot className={footerStyles.logo} />
              <span className={footerStyles.name}>StelHacks<span>.</span></span>
            </a>
            <p className={footerStyles.tagline}>A home for Stellar builders.</p>
          </div>
          <nav className={footerStyles.links} aria-label="Footer">
            {[
              { title: "Hackathons", href: "/hackathons" },
              { title: "Statistics", href: "/statistics" },
              { title: "How it works", href: "/how-it-works" },
              { title: "Stellar", href: "https://stellar.org", external: true },
            ].map((link) => (
              <a
                key={link.href}
                href={link.href}
                className={footerStyles.link}
                {...(link.external ? { target: "_blank", rel: "noreferrer" } : {})}
              >
                {link.title}{link.external && <span aria-hidden="true"> ↗</span>}
              </a>
            ))}
          </nav>
        </div>
        <div className={footerStyles.bottom}>
          <span>© {new Date().getFullYear()} StelHacks</span>
          <span className={footerStyles.builtOn}>Build on Stellar</span>
        </div>
      </div>
    </footer>
  );
}
