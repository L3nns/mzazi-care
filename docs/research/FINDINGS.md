# Research findings (Phase 6)

What the experiments in [RESULTS.md](RESULTS.md) show, what they do not, and
what was changed because of them. Every number here is copied from that file;
rerun `python -m research.run_all` to regenerate it. Intervals are 95%
bootstrap intervals; "significant" means the Holm-corrected Wilcoxon p-value is
below 0.05.

## Read this first: limits

- **The interactions are synthetic.** The generator that produced them gives
  parents category preferences, which favours content-based methods. The
  recommendation results describe this data, not Nairobi parents.
- **The search queries were written by the developer,** who also wrote the
  thesaurus. I avoided the listings' own wording, but a bias towards the
  thesaurus vocabulary is likely, so the thesaurus arms may look better than
  they would on real queries.
- **Relevance is category-level.** Any verified provider in an acceptable
  category, in the named area when there is one, counts as relevant. Quality
  differences within a category are not judged.
- **The test sets are small.** There are 48 answerable test queries and only 7
  out-of-scope ones, so many intervals are wide and many differences are not
  significant. "Not significant" is not "no difference".
- **Latency** comes from one run on one laptop (CPU only).

## Search

**S1. Search as served today misses most natural queries.** The live route
runs keyword SQL first. Every term must match, so it returned nothing on
**69% of answerable test queries**: nDCG@10 0.272, with 0.000 on Kiswahili and
mixed queries. The enhanced engine scores 0.800, a difference of +0.528
[0.410, 0.642], significant. When the keyword search is empty the page asks the
engine for "suggestions". That recovers a lot (0.701), but the suggestions are
capped at 6, labelled as suggestions rather than results, and still trail the
engine by 0.099 [0.058, 0.148], significant. *This is the largest gap the
benchmark found.*

**Changed in Phase 7.** Free text is now matched by the engine, with keyword
SQL kept for name matches and as the fallback. Measured through the live route
on the same test queries:

| Measure | Keyword route (before) | Semantic route (now) |
| --- | --- | --- |
| nDCG@10 | 0.272 | 0.811 |
| Answerable queries that returned nothing | 69% | 2% |
| Median request time | 51 ms | 24 ms |

The change is +0.539 [0.421, 0.654]: better on 34 queries, worse on none,
significant. Counting the suggestions the old page offered, it is still +0.110
[0.067, 0.159]. The new route is faster because the old one usually needed a
second call to the engine for suggestions.

**What it cost: out-of-scope requests.** The keyword route returned nothing for
all 7 out-of-scope test queries. The new route returns listings for 4 of them,
for example "fundi wa magari" (car mechanic). S5 shows that a cut-off cannot
remove them without also turning away real questions. So when the best match's
similarity is below 0.40 (the dev-split choice in S5), the route marks the
results `match_quality: weak`. The page then says that none of them clearly
matches, and presents them as the closest services listed. This labels; it
does not hide anything. A weak match shows only the five closest services:
the relevance floor is a share of the best match, so when the best match is
itself weak, almost everything passes ("fundi wa magari" listed 38).

**S2. The thesaurus does most of the work, especially for Kiswahili.** Removing
it from the engine costs 0.206 nDCG [0.098, 0.313], significant. Without it, the
sentence model scores 0.087 on Kiswahili queries; with it, 0.738. Kiswahili is
handled by the hand-written thesaurus, not by the model.

**S3. With the thesaurus, BM25 is not measurably worse than the engine.**
Overall, enhanced minus BM25 + thesaurus is +0.033 [−0.050, 0.118], not
significant. BM25 + thesaurus answers in 0.3 ms against the engine's 24.6 ms.
The sentence model's advantage shows only on English paraphrases (0.846 for
SBERT + thesaurus against 0.521 for BM25 + thesaurus). That is descriptive,
from 12 queries, with no test run on it.

**S4. The relevance floor trades recall for cleaner lists, as designed.**
Turning the floor off raises nDCG by 0.049 [0.017, 0.097] (significant) and
recall from 0.739 to 0.812. But the share of returned results that are relevant
falls from 0.769 to 0.486. The rule fixed before the experiment, best dev F1
of list precision and recall, kept 0.85. The cost is visible: "paediatrician
near Runda" returns nothing, because Runda's two paediatric listings score just
under 85% of the best paediatric match elsewhere. The default stays at 0.85,
because a search page that shows wrong services as "results" is worse for a
parent than a shorter list. A floor measured within the chosen area, kept for
area searches with at least one plausible local match, is worth testing next.

**S5. A single similarity threshold cannot detect out-of-scope requests.** The
best in-catalogue similarity of real and out-of-scope queries overlaps:

- "I feel sad since my baby was born" 0.362, "doula" 0.378;
- "nyumba ya kupangisha" (house to rent) 0.380, "mwalimu wa kuendesha gari"
  (driving instructor) 0.415.

The dev rule picks 0.40. **I did not adopt it.** At 0.40 the engine would turn
away the postnatal-depression query above, plus "doula" and "what to eat while
pregnant". The default stays at 0.25, which rejects 3 of the 7 out-of-scope
test queries. The failures are mostly Kiswahili phrases, which the English
model scores as vaguely similar to everything. 0.30 would reject one more
out-of-scope dev query with no false rejections, but I chose it after seeing
the test queries, so it is not a validated result. Better options are a model
that knows Kiswahili, or explicit out-of-scope handling.

**S6. Place parsing works, but its overall effect is not significant.**

- The Python port agrees with the live route on 113 of 113 queries.
- On place queries the engine scores 0.891, against 0.775 for SBERT +
  thesaurus without parsing (descriptive).
- Across all queries, removing parsing changes nDCG by −0.026 [−0.067, 0.010],
  not significant.
- Lexical systems also do well on place queries (BM25 + thesaurus 0.910),
  because area names appear in the listing text.

**S7. The related-category slot costs little.** Removing it raises nDCG by
0.011 [0.002, 0.023], not significant after correction. It exists for variety
while behaviour data is thin, and is labelled on the page.

**Thesaurus gaps seen on dev queries.** "toddler", "milestones",
"sleep/tantrums", "uchungu" (labour pains), "hatari" (high risk),
"hazungumzi" (does not talk yet). I did not add them. Doing so after
seeing the benchmark would tune the system to its own test. They should come
from real parents' queries.

## Recommendations

**R1. Every learned model beats random and popularity by a wide margin** (hybrid
recall@10 +0.72). Popularity is no better than random (0.100 against 0.108) and
reaches only 12% of the catalogue. In this data, interactions follow
category preferences, not popularity.

**R2. The hybrid beats collaborative-only, but not content-only.**

| Hybrid compared with | Recall | nDCG | Significant? |
| --- | --- | --- | --- |
| Collaborative-only | +0.075 [0.029, 0.121] | +0.053 | Yes |
| Content-only | +0.037 [−0.004, 0.079] | −0.006 | No |

A claim that "the hybrid outperforms its components" holds only for the
collaborative component on this data.

**R3. The TF-IDF encoder is at least as good for recommendations.** The TF-IDF
hybrid has higher nDCG than the sentence-model hybrid by 0.027 [0.013, 0.041],
significant; recall does not differ significantly. Together with S3, the
sentence model's measured advantage is limited to English paraphrased search.
Using TF-IDF for behaviour-based recommendations and the sentence model for
search is a candidate configuration, to be confirmed on real data.

**R4. Diversity re-ranking (MMR) gives little, at a small cost.**

- Validation chose λ = 0.8.
- On test it adds 0.31 categories per list (4.14 to 4.45).
- Recall changes by −0.008 (not significant) and nDCG by −0.005 [−0.010, −0.001]
  (significant).
- λ = 0.5 would give 5.4 categories but failed the validation tolerance.

MMR stays off by default.

**R5. The location and quality weights stay at 0,** as in Phase 3: on
validation, any weight above 0 lowered recall.

## What changed because of this phase

- **Ranking defaults: none.** The floor stays at 0.85 (the dev rule kept it),
  the no-match threshold at 0.25 (against the dev rule; see S5), and MMR off.
- **Bug fixed: corrupted text in MySQL.** `seed_data.sql` did not set the
  connection character set, so loading it with the Windows `mysql` client
  stored "crèche" as "cr├¿che". This affected category 23 and providers
  109–115. `SET NAMES utf8mb4` was added to `seed_data.sql` and `schema.sql`,
  and the 8 corrupted values in the local database were restored from the CSV.
  The benchmark found this through its catalogue fingerprint check.
- **`engine.evaluate` additions.**
  - It can score an outside ranker (the random and popularity baselines) with
    the same code.
  - It can measure diversity in another engine's vector space. Without that,
    the TF-IDF hybrid appeared to have diversity 0.818 against 0.251, an
    artefact of comparing two different spaces.
  - It returns every metric per user, for paired tests.

## Suggested next steps, in order of expected effect

1. ~~Make the engine the primary search for free text (S1).~~ Done in Phase 7.
2. Collect real parent queries, in English, Kiswahili and Sheng, through
   stakeholder testing. Use them to extend the thesaurus and to relabel the
   benchmark (S2, the gaps listed above).
3. Evaluate a Kiswahili-capable encoder and explicit out-of-scope handling (S5).
4. Recheck content-only against the hybrid, and TF-IDF against SBERT, once real
   interaction data exists (R2, R3).
