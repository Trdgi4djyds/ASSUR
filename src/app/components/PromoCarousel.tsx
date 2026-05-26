import { useEffect, useState } from "react";
import { Link } from "react-router";
import { motion, AnimatePresence } from "motion/react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ImageWithFallback } from "./figma/ImageWithFallback";
import { api } from "../espace-client/api";

import ad1 from "../../imports/images__9_.png";
import ad2 from "../../imports/african-woman-successful-small-business-600nw-2745247757.jpg";
import ad3 from "../../imports/trois-femmes-africaines-choisissent-vetements-lors-journee-magasinage_926199-2565282.jpg";
import ad4 from "../../imports/SMS-PRO__2_.jpg";
import ad5 from "../../imports/SLIDER_ASSO_TCHE-03__2_.jpeg";
import ad6 from "../../imports/images_-_2026-04-10T164300.056.jpeg";
import ad7 from "../../imports/images_-_2026-04-10T163945.322.jpeg";
import ad8 from "../../imports/ecobank_ci_0.jpg";

interface AdSlide {
  id: string;
  image: string;
  alt: string;
  to?: string;
}

const defaultSlides: AdSlide[] = [
  { id: "ad-1", image: ad1, alt: "Annonce IPPOO", to: "/produits" },
  { id: "ad-2", image: ad2, alt: "Femme entrepreneure", to: "/produits/marchandises" },
  { id: "ad-3", image: ad3, alt: "Commerçantes au marché", to: "/produits/sante-maladie" },
  { id: "ad-4", image: ad4, alt: "Promotion SMS Pro", to: "/contact" },
  { id: "ad-5", image: ad5, alt: "Slider association", to: "/comment-ca-marche" },
  { id: "ad-6", image: ad6, alt: "Annonce partenaire", to: "/points-partenaires" },
  { id: "ad-7", image: ad7, alt: "Annonce partenaire", to: "/devis" },
  { id: "ad-8", image: ad8, alt: "Ecobank partenaire", to: "/contact" },
];

export function PromoCarousel({ bare = false }: { bare?: boolean } = {}) {
  const [index, setIndex] = useState(0);
  const [slides, setSlides] = useState<AdSlide[]>(defaultSlides);

  useEffect(() => {
    let cancelled = false;
    api.promos().then((r) => {
      if (cancelled) return;
      const active = (r.promos ?? []).filter((p) => p.active !== false && p.image);
      if (active.length) setSlides(active.map((p) => ({ id: p.id, image: p.image, alt: p.alt, to: p.to })));
    }).catch(() => { /* keep defaults */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setIndex((i) => (i + 1) % slides.length), 5500);
    return () => clearInterval(t);
  }, [slides.length]);

  const go = (n: number) => setIndex((n + slides.length) % slides.length);
  const slide = slides[index % slides.length];
  if (!slide) return null;

  const Wrapper: React.ElementType = slide.to ? Link : "div";
  const wrapperProps: Record<string, unknown> = slide.to ? { to: slide.to } : {};

  return (
    <section className={bare ? "" : "px-4 sm:px-6 lg:px-8 py-8 sm:py-12"}>
      <div className={bare ? "w-full" : "max-w-5xl mx-auto"}>
        <div className="relative rounded-[24px] sm:rounded-[32px] overflow-hidden bg-[#0E1320]/5 shadow-[0_30px_80px_-20px_rgba(14,19,32,0.25)]">
          <AnimatePresence mode="wait">
            <motion.div
              key={slide.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.5, ease: "easeOut" }}
              className="relative flex items-center justify-center"
            >
              <Wrapper {...wrapperProps} className="block w-full">
                <ImageWithFallback
                  src={slide.image}
                  alt={slide.alt}
                  className="w-full h-auto object-contain block"
                />
              </Wrapper>
            </motion.div>
          </AnimatePresence>

          {/* Controls */}
          <button
            type="button"
            aria-label="Précédent"
            onClick={() => go(index - 1)}
            className="absolute left-3 sm:left-4 top-1/2 -translate-y-1/2 w-10 h-10 sm:w-11 sm:h-11 rounded-full bg-white/85 hover:bg-white backdrop-blur-md flex items-center justify-center text-[#0E1320] shadow-lg transition-all"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <button
            type="button"
            aria-label="Suivant"
            onClick={() => go(index + 1)}
            className="absolute right-3 sm:right-4 top-1/2 -translate-y-1/2 w-10 h-10 sm:w-11 sm:h-11 rounded-full bg-white/85 hover:bg-white backdrop-blur-md flex items-center justify-center text-[#0E1320] shadow-lg transition-all"
          >
            <ChevronRight className="w-5 h-5" />
          </button>

          {/* Dots */}
          <div className="absolute bottom-3 sm:bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-white/80 backdrop-blur-md rounded-full px-3 py-1.5 shadow-md">
            {slides.map((s, i) => (
              <button
                key={s.id}
                type="button"
                aria-label={`Aller à l'annonce ${i + 1}`}
                onClick={() => setIndex(i)}
                className={`h-2 rounded-full transition-all ${
                  i === index ? "w-6 bg-[#FF3B57]" : "w-2 bg-[#0E1320]/30 hover:bg-[#0E1320]/60"
                }`}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
