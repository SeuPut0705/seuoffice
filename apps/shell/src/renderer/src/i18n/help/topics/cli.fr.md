# Ligne de commande et agents

Chaque installation livre une commande `ieumoffice` qui pilote les mêmes moteurs que la fenêtre : les mêmes analyseurs, le même rédacteur, le même moteur de rendu. Un fichier enregistré par l’application et un fichier écrit par la commande sont le même fichier, et un contrôle que le panneau IA de l’application valide, la commande le valide aussi.

```sh
ieumoffice --help          # every command
ieumoffice guide slides    # the op reference, for writing your own
```

`ieumoffice --help` présente toute la surface sur un seul écran : chaque commande avec une ligne qui dit ce qu'elle fait, puis les options globales et les codes de sortie.

## Obtenir la commande

La commande est livrée dans l’application. Pour l’appeler par son nom, lancez une fois `ieumoffice install-cli` : sous Windows, il ajoute le dossier qui contient la commande à votre `PATH` utilisateur, et les terminaux ouverts ensuite la trouvent. **Paramètres ▸ Intégrations** indique si votre terminal trouve déjà la commande et, sinon, la ligne exacte à exécuter.

Les agents de programmation n’ont pas besoin de cette étape. L’application note l’emplacement de la commande dans `~/.ieumoffice/launcher`, et ils la trouvent là.

## Les commandes à connaître

| Commande          | Ce qu’elle fait                                                                                                                                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`            | Ouvrir un document dans l’application ; démarre l’application si elle ne tourne pas.                                                                                                                                                                                                     |
| `selection`       | Ce que l’utilisateur a sélectionné dans ce fichier à l’instant, tant que l’application tourne — le pointeur vers « celui-ci » / « ici ». Renvoie une plage de blocs, une plage de la feuille, des éléments de diapositive ou une page, selon l’éditeur dans lequel se trouve le fichier. |
| `convert`         | Convertir entre formats avec les moteurs de l’application.                                                                                                                                                                                                                               |
| `create`          | Créer un document à partir de contenu structuré.                                                                                                                                                                                                                                         |
| `render`          | Un PNG par page, tel que le moteur de rendu le met en page.                                                                                                                                                                                                                              |
| `pdf`             | Lire la couche de texte d’un PDF page par page, sans lancer l’application.                                                                                                                                                                                                               |
| `read-url`        | Lire le texte d’une page web en ligne de commande — un article, un document ou le lien d’une compétence ; affiche le texte et poursuit avec `--offset`.                                                                                                                                  |
| `info`            | Métadonnées et résumé de la structure d’un document.                                                                                                                                                                                                                                     |
| `search`          | Recherche web ou d’images : la recherche gratuite par défaut, ou le fournisseur de recherche dont vous avez sélectionné la clé dans l’application.                                                                                                                                       |
| `image` / `media` | Générer une image, ou décrire un fichier image, vidéo ou audio et lui poser des questions.                                                                                                                                                                                               |
| `merge`           | Remplir les espaces réservés `{{key}}` d’un modèle `.docx`, `.pptx` ou `.xlsx`.                                                                                                                                                                                                          |
| `capabilities`    | Indiquer quelles fonctions d’IA (recherche, génération d’images, analyse d’images et de vidéos) sont disponibles sur cette machine, et par quelle voie.                                                                                                                                  |
| `guide`           | La référence des ops et les guides de conception, générés à partir des définitions mêmes contre lesquelles l’executor valide : ils ne peuvent donc pas diverger de ce que `apply` accepte. `--json` renvoie le tout avec le schéma de chaque op.                                         |
| `install-cli`     | Placer `ieumoffice` sur le `PATH`.                                                                                                                                                                                                                                                       |
| `skill`           | Lister les agents de programmation trouvés sur cette machine et y installer ou mettre à jour la compétence GenOffice.                                                                                                                                                                    |
| `mcp`             | Exposer chaque commande comme un outil Model Context Protocol. Voir **Connecter un agent de codage**.                                                                                                                                                                                    |

## Édition : documents, tableurs, présentations

`ieumoffice docs`, `ieumoffice sheet` et `ieumoffice slides` lisent et modifient par le même chemin d’écriture que l’application, et partagent un même vocabulaire : un **op** est une seule modification, et une **spec** est une liste d’ops appliquées dans l’ordre.

```sh
ieumoffice sheet read report.xlsx
ieumoffice slides apply deck.pptx --ops ops.json --dry-run
ieumoffice docs apply brief.docx --ops ops.json
```

`--dry-run` rapporte ce qu’un lot ferait et n’écrit rien : c’est le moyen bon marché de vérifier une spec avant qu’elle ne s’applique. Le panneau IA de l’application s’exécute exactement sur ces ops, donc tout ce que vous pouvez lui demander se script.

## Les commandes de recherche, d’image et de média

`search`, `image` et `media` utilisent ce qui est configuré dans l’application sous Paramètres ▸ IA ▸ Avancé :

- `search` fonctionne toujours. Elle utilise la recherche gratuite par défaut, ou le fournisseur de recherche dont vous avez sélectionné la clé.
- `image` a besoin de la clé d’un fournisseur d’images. Dans cette version, un abonnement ne génère pas d’images.
- `media` sur une image utilise un fournisseur à clé lorsqu’il y en a un de configuré. Elle n’utilise votre abonnement Claude ou Codex que si vous l’avez autorisé, et c’est **désactivé par défaut** ; [Connecter un agent de codage](help://mcp) explique ce réglage et ses limites.
- `media` sur une vidéo ou un fichier audio a besoin d’un fournisseur à clé qui prend en charge la vidéo.

`ieumoffice capabilities --json` indique tout cela sans appeler aucune IA. Son `detail` contient :

| Champ                                                                            | Ce qu’il indique                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `search`, `image_search`, `image_generation`, `image_analysis`, `video_analysis` | Pour chaque fonction : `available` ; `via`, qui répond ; `route`, l’une des valeurs `free`, `key` ou `subscription` ; `metered: true` pour une connexion facturée à l’usage ; et, lorsque la fonction est indisponible, `message`, le texte par lequel la commande répond elle-même. |
| `media_analysis`                                                                 | Conservé pour les anciens scripts : identique à `image_analysis`, ou à `video_analysis` lorsque seule la vidéo fonctionne.                                                                                                                                                           |
| `automatic_calls`                                                                | `subscription_enabled` et, tant que c’est activé, `used`, le nombre de requêtes automatiques traitées au cours de la dernière heure (à titre indicatif) ; `limit` et `remaining` valent toujours `null`.                                                                             |
| `app`                                                                            | `available` : si l’application est installée à un endroit où la commande peut la lancer.                                                                                                                                                                                             |
| `settings_path`                                                                  | Le fichier de paramètres d’où ces réponses ont été lues.                                                                                                                                                                                                                             |

Lorsque `image` ou `media` ne peut pas s’exécuter, la commande se termine avec le code 4 et `error: "app_unavailable"`, et `detail.errorCode` en donne la raison. `unavailable` signifie que rien n’est configuré pour la fonction : réessayer ne servira donc à rien. `rate-limit` est accompagné de `detail.resetsAt`, l’heure (en millisecondes) à laquelle les requêtes redeviennent possibles.

## Ce qu’elle conserve sur ce PC

Les deux fichiers se trouvent dans le dossier `.ieumoffice` de votre dossier utilisateur :

- `~/.ieumoffice/launcher` note l’emplacement de la commande de l’application, pour qu’un agent de programmation la trouve même lorsqu’elle n’est pas sur votre `PATH`.
- `~/.ieumoffice/cli-audit.jsonl` reçoit une ligne pour chaque commande exécutée — la commande, ses arguments et le résultat —, ce qui vous permet de voir après coup ce qu’un agent a fait.

## Model Context Protocol

`ieumoffice mcp` expose chaque commande comme un outil MCP, et `ieumoffice mcp install <agent|all>` l’enregistre dans la configuration d’un agent de programmation. Pour ce côté-là, voir **Connecter un agent de codage**.

## Ce que la commande ne fait pas

Elle lit et écrit le fichier. Ce n’est pas l’application : il n’y a pas de fenêtre, et la boîte de dialogue de mise à jour de l’application ne s’applique pas. Tout ce qui a besoin de la fenêtre — le panneau IA, le contrôle QC d’une diapositive rendue — attend que vous ouvriez le fichier. `ieumoffice render` vous donne les pixels sans elle, et `ieumoffice slides` audite la mise en page d’un diaporama tout seul.
