export default {
  extends: ['@commitlint/config-conventional'],
  // Dependabot recopie les notes de version dans le corps du commit (lignes
  // > 100 caractères) : son format n'est pas maîtrisable, on l'exempte.
  ignores: [(message) => /^Signed-off-by: dependabot\[bot\]/m.test(message)],
};
