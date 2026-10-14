# -*- coding: utf-8 -*-
"""
Domain vocabulary expansion for maternal and childcare services.

The failure this fixes: a parent types "someone to help me breastfeed" and the
listing says "lactation consultant, latch support". A bag-of-words model scores
that pair at zero because they share no terms. Expanding both sides with a small
domain thesaurus closes most of that gap cheaply, and it helps every encoder -
including the neural one, which still benefits from the Kiswahili terms.

This is the "standardises category and tag variants" step named in Section 3.2.2
of the proposal, so it needs no change to the stated methodology.
"""
from __future__ import annotations
import re
from typing import Iterable

# Each group is a set of terms that should pull towards one another. Kiswahili
# terms are included because Nairobi users routinely mix the two languages.
SYNONYM_GROUPS: list[list[str]] = [
    ["breastfeeding", "breast feeding", "nursing", "lactation", "latch",
     "milk supply", "expressing", "kunyonyesha", "maziwa ya mama"],
    ["pregnancy", "pregnant", "expecting", "expectant", "gestation", "prenatal",
     "antenatal", "ante natal", "mimba", "mja mzito", "mjamzito", "ujauzito"],
    ["birth", "labour", "labor", "delivery", "childbirth", "giving birth",
     "kujifungua", "uzazi"],
    ["midwife", "midwifery", "birth attendant", "mkunga"],
    ["doula", "birth companion", "birth partner", "labour support"],
    ["postnatal", "postpartum", "after birth", "after delivery", "recovery",
     "baada ya kujifungua"],
    ["newborn", "infant", "baby", "neonate", "mtoto mchanga", "mtoto"],
    ["paediatric", "pediatric", "paediatrician", "pediatrician", "child doctor",
     "daktari wa watoto"],
    ["immunisation", "immunization", "vaccination", "vaccine", "jab", "chanjo"],
    ["nanny", "house help", "caregiver", "child minder", "childminder", "ayah",
     "yaya", "mlezi"],
    ["daycare", "day care", "creche", "crèche", "childcare centre",
     "childcare center", "nursery", "chekechea", "kituo cha watoto"],
    ["mental health", "depression", "anxiety", "counselling", "counseling",
     "therapy", "therapist", "emotional support", "baby blues",
     "postnatal depression", "afya ya akili"],
    ["nutrition", "nutritionist", "dietitian", "dietician", "diet", "feeding",
     "weaning", "lishe"],
    ["fitness", "exercise", "yoga", "workout", "pelvic floor", "mazoezi"],
    ["special needs", "disability", "autism", "developmental delay",
     "occupational therapy", "speech therapy"],
    ["parenting", "parent coaching", "sleep training", "behaviour", "behavior",
     "discipline", "malezi"],
    ["scan", "ultrasound", "sonogram"],
    ["clinic", "hospital", "health centre", "health center", "dispensary",
     "kliniki", "hospitali", "zahanati"],
    ["affordable", "cheap", "low cost", "budget", "bei nafuu"],
    ["home visit", "home based", "at home", "house call", "nyumbani"],
]

# Irregular forms the stemmer below cannot reach from the listed terms.
EXTRA_FORMS: dict[str, str] = {
    "breastfeed": "breastfeeding", "breastfed": "breastfeeding",
    "nurse": "breastfeeding", "lactating": "breastfeeding",
    "pump": "breastfeeding", "pumping": "breastfeeding",
    "born": "birth", "deliver": "birth", "delivering": "birth",
    "vaccinate": "immunisation", "vaccinated": "immunisation",
    "immunise": "immunisation", "immunize": "immunisation",
    "counsellor": "mental health", "counselor": "mental health",
    "wean": "nutrition", "weaning": "nutrition", "feed": "nutrition",
    "paediatrics": "paediatric", "pediatrics": "paediatric",
    "kids": "newborn", "toddler": "newborn", "watoto": "newborn",
    "preschool": "daycare", "pre school": "daycare",
}

# term -> canonical tag for its group
_LOOKUP: dict[str, str] = {}
for _grp in SYNONYM_GROUPS:
    _canon = _grp[0].replace(" ", "_")
    for _term in _grp:
        _LOOKUP[_term.lower()] = _canon
for _form, _target in EXTRA_FORMS.items():
    _LOOKUP[_form.lower()] = _LOOKUP[_target.lower()]

# longest first, so "breast feeding" matches before "feeding"
_TERMS = sorted(_LOOKUP.keys(), key=len, reverse=True)
_PATTERN = re.compile(
    r"\b(" + "|".join(re.escape(t) for t in _TERMS) + r")\b", re.IGNORECASE
)

_SUFFIXES = ("ing", "ed", "es", "s")


def _stem(word: str) -> str:
    """Strip common inflections repeatedly until stable: breastfeeding -> breastfe."""
    w = word.lower()
    changed = True
    while changed:
        changed = False
        for suf in _SUFFIXES:
            if w.endswith(suf) and len(w) - len(suf) >= 4:
                w, changed = w[: -len(suf)], True
                break
    return w


# stem -> canonical tag, built from the single-word entries only. Multi-word
# phrases are handled by the regex, which runs first.
_STEM_LOOKUP: dict[str, str] = {}
for _term, _canon in _LOOKUP.items():
    if " " not in _term:
        _STEM_LOOKUP.setdefault(_stem(_term), _canon)

_WORD = re.compile(r"[a-z]+")

# Spelling variants of one term, collapsed before anything else reads the text
# (Section 3.2.2: "Child Care", "Childcare" and "Child-Care" are one form).
_VARIANTS: list[tuple[re.Pattern, str]] = [
    (re.compile(p, re.IGNORECASE), r) for p, r in (
        (r"\bchild[\s_-]+care\b", "childcare"),
        (r"\bday[\s_-]+care\b", "daycare"),
        (r"\bhealth[\s_-]+care\b", "healthcare"),
        (r"\bbreast[\s_-]+(feed|fed)", r"breast\1"),
        (r"\bante[\s_-]+natal\b", "antenatal"),
        (r"\bpre[\s_-]+natal\b", "prenatal"),
        (r"\bpost[\s_-]+natal\b", "postnatal"),
        (r"\bpost[\s_-]+partum\b", "postpartum"),
        (r"\bnew[\s_-]+born\b", "newborn"),
        (r"\bchild[\s_-]+minder\b", "childminder"),
        (r"\bpre[\s_-]+school\b", "preschool"),
        (r"\bhome[\s_-]+visits?\b", "home visit"),
    )
]
_PUNCT = re.compile(r"[^\w\s']+", re.UNICODE)
_SPACE = re.compile(r"\s+")


def standardise(text: str) -> str:
    """Collapse spelling variants of the same term onto one form."""
    for pat, repl in _VARIANTS:
        text = pat.sub(repl, text)
    return text


def preprocess(text: str) -> str:
    """Section 4.8.1 preprocessing: lowercase, strip punctuation, standardise
    variants. Stop words are left in place on purpose - TF-IDF removes them
    itself, and a sentence encoder needs them to read the sentence."""
    if not text:
        return ""
    low = _PUNCT.sub(" ", str(text).lower().replace("-", " "))
    return _SPACE.sub(" ", standardise(low)).strip()


def canonical_tags(text: str) -> list[str]:
    """Every canonical group tag that appears in the text, de-duplicated."""
    if not text:
        return []
    low = text.lower()
    seen, out = set(), []

    def add(tag):
        if tag not in seen:
            seen.add(tag)
            out.append(tag)

    for m in _PATTERN.finditer(low):          # exact terms and phrases
        add(_LOOKUP[m.group(1).lower()])
    for w in _WORD.findall(low):              # inflected single words
        tag = _STEM_LOOKUP.get(_stem(w))
        if tag:
            add(tag)
    return out


def expand(text: str, repeat: int = 1) -> str:
    """
    Preprocess the text, then append the canonical tags for whatever domain
    terms it contains.

    `repeat` controls how strongly the tags weigh in a bag-of-words model; the
    neural encoder ignores it in practice because it reads the sentence, not
    term counts.
    """
    text = preprocess(text)
    tags = canonical_tags(text)
    if not tags:
        return text
    return text + " " + " ".join(tags * max(1, repeat))


def expand_all(texts: Iterable[str], repeat: int = 1) -> list[str]:
    return [expand(t, repeat) for t in texts]


if __name__ == "__main__":
    demo = [
        "someone to help me breastfeed",
        "lactation consultant offering latch support and milk supply advice",
        "natafuta yaya wa mtoto",
        "nanny placement agency with vetted staff",
    ]
    for d in demo:
        print(f"{d!r}\n   -> {canonical_tags(d)}\n")
