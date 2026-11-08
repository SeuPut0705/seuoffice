# Mode agent

L’agent prend comme projet un dossier que vous choisissez et lance dans ce dossier le Claude Code ou le Codex de ce PC. L’IA lit elle-même le contenu du dossier, crée de nouveaux fichiers, utilise des compétences et des scripts, et modifie les documents ouverts dans GenOffice. Servez-vous-en pour un travail qui s’appuie sur beaucoup de sources.

## Avant de commencer

- Le programme Claude Code ou Codex connecté dans **Paramètres ▸ IA** (connecté avec un abonnement Claude ou un forfait ChatGPT). ChatGPT connecté directement dans l’application n’est pas utilisé par l’agent. La rubrique « Connexion par abonnement » explique comment faire.
- Un dossier qui rassemble vos sources. Un lecteur entier, la totalité de votre dossier personnel et les dossiers de données de connexion ou d’application ne peuvent pas être choisis.

## Démarrer une session

1. Dans la barre latérale gauche de l’accueil, cliquez sur **Agent**. La fenêtre de l’agent s’ouvre à part.
2. Cliquez sur **Choisir un dossier…** pour sélectionner le dossier du projet. Les dossiers utilisés récemment figurent sous **Dossiers récents**.
3. Sous **Programme**, choisissez Claude Code ou Codex. Un programme qui n’est pas connecté ne peut pas être choisi.
4. Sous **Quand vous demander**, choisissez la façon dont l’agent vous demande l’autorisation (tableau ci-dessous).
5. La première fois, lisez **Avant de commencer** et cliquez sur **J’ai compris**.
6. Cliquez sur **Démarrer**, écrivez ce que vous voulez faire faire, puis cliquez sur **Envoyer**.

Une fenêtre correspond à une session. Fermer la fenêtre ou cliquer sur **Arrêter** met fin à la session, et le programme que GenOffice a lancé pour elle s’arrête aussi. Une session prend également fin après 30 minutes sans aucun envoi.

## Comment l’agent vous demande

| Choix                                           | Se fait directement                                                                   | Demande d’abord                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Demander avant chaque commande** (par défaut) | Lire et écrire des fichiers dans le dossier du projet, modifier les documents ouverts | Exécuter une commande ou un script, lire hors du dossier du projet          |
| **Demander avant l’écriture et les commandes**  | Lire des fichiers dans le dossier du projet, modifier les documents ouverts           | Écrire un fichier, exécuter une commande ou un script, lire hors du dossier |
| **Faire confiance à ce projet**                 | Presque tout                                                                          | Lire hors du dossier du projet                                              |

Quand l’agent demande, la fenêtre montre ce qu’il veut faire (la commande complète, le chemin du fichier). Cliquez sur **Autoriser** ou **Refuser**.

Quel que soit votre choix, l’agent ne peut pas :

- Écraser le fichier d’un document ouvert dans un onglet GenOffice. Les documents ouverts sont modifiés par l’intermédiaire de l’application : la modification apparaît aussitôt dans l’éditeur, et la fonction Annuler de l’éditeur la défait.
- Écrire hors du dossier du projet.
- Toucher aux données de connexion de Claude ou de Codex, ni au dossier de données de GenOffice.

## Claude Code et Codex

- **Codex** exécute les commandes dans son propre espace isolé, y compris celles que vous autorisez. Il ne peut écrire que dans le dossier du projet, Internet lui est fermé tant que vous ne l’activez pas, et il ne peut pas lire vos fichiers personnels hors du projet. Au début d’une session, GenOffice vérifie d’abord que cet isolement fonctionne sur ce PC, et ne démarre pas si ce n’est pas le cas.
- **Claude Code** ne peut pas isoler les commandes sous Windows. Une commande que vous autorisez peut atteindre tout le PC et Internet. C’est pourquoi, avec **Faire confiance à ce projet**, c’est le propre vérificateur de Claude Code qui contrôle chaque action à votre place.

Un document que quelqu’un vous a envoyé peut contenir des instructions cachées qui poussent l’IA à faire autre chose. Dans un dossier dont vous ne connaissez pas le contenu, choisissez une des options qui vous demandent.

## Recherche web et Internet

- **Claude Code** peut faire des recherches sur le web et lire des pages web, mais il demande d’abord. Il demande la première fois qu’il lance une recherche, puis pour chaque site dont il lit des pages. Dans la question, **Autoriser les recherches pour cette session** ou **Autoriser ce site pour cette session** lui évite de redemander jusqu’à la fin de la session. Avec **Faire confiance à ce projet**, c’est le propre vérificateur de Claude Code qui décide.
- Quand vous choisissez **Codex**, l’écran de démarrage affiche deux réglages de plus.

| Réglage                                 | Choix                                          | Au départ             |
| --------------------------------------- | ---------------------------------------------- | --------------------- |
| **Recherche web**                       | Résultats enregistrés / En direct / Désactivée | Résultats enregistrés |
| **Accès à Internet pour les commandes** | Désactivé / Activé                             | Désactivé             |

- Les résultats enregistrés proviennent de contenus web collectés à l’avance ; En direct interroge le web tel qu’il est maintenant.
- Les deux réglages sont mémorisés pour chaque dossier de projet. Un dossier utilisé pour la première fois part des valeurs ci-dessus.
- Quand l’accès à Internet pour les commandes est activé, les commandes lancées par Codex peuvent atteindre Internet. Avec **Faire confiance à ce projet**, elles y accèdent sans demander, et des instructions cachées dans un document reçu pourraient leur faire envoyer vos données à l’extérieur. Cet avertissement s’affiche quand vous l’activez. Ne l’activez que si vous en avez besoin. La compétence intégrée « Trouver des compétences » ne fonctionne qu’avec ce réglage activé.

## Notes de projet et compétences

- Si le dossier contient un `CLAUDE.md` ou un `AGENTS.md`, son contenu est transmis à l’agent comme instructions. Notez-y ce qui doit valoir à chaque fois : le ton, les termes, le format des documents à produire.
- La fenêtre de l’agent utilise les compétences activées dans **Paramètres ▸ Compétences**. Claude Code et Codex reçoivent la même liste. Pour en savoir plus sur les compétences, voir [Compétences](help://skills).
- Les compétences des dossiers `.claude/skills` et `.agents/skills` du projet sont utilisées dans cette session sans avoir besoin d’être activées.
- Choisissez une compétence avec `/` ou `$` dans la zone de saisie : une instruction demandant de lire et de suivre cette compétence est placée devant votre demande.
- La liste des compétences est fixée au démarrage de la session. Si vous activez ou désactivez des compétences pendant une session, « Les compétences modifiées s’appliquent à partir de la prochaine session » s’affiche.
- Quand l’agent crée une compétence, une carte de compétence apparaît dans la fenêtre ; quand il trouve une compétence qui mérite d’être installée, un aperçu d’installation apparaît. Rien n’est enregistré ni installé tant que vous n’avez pas cliqué sur **Enregistrer** ou **Installer**, et une compétence installée est disponible à partir de la prochaine session.
- Les programmes dont se servent les scripts d’une compétence (Python, etc.) doivent être installés sur ce PC.
- Si vous avez utilisé l’agent dans une version précédente, la première fois que vous ouvrez la fenêtre de l’agent, un avis affiché une seule fois indique : « Les compétences s’activent et se désactivent désormais dans Paramètres → Compétences. Les compétences des dossiers de compétences Claude et Codex sont désactivées au départ. » **Ouvrir les paramètres** vous y mène directement.

## Nouveaux fichiers et documents ouverts

- Les nouveaux fichiers créés par l’agent sont enregistrés dans le dossier du projet. Cliquez sur **Ouvrir** sur la ligne correspondante du journal de progression pour ouvrir le fichier dans un onglet GenOffice.
- Pour faire modifier un document ouvert, ouvrez-le d’abord dans GenOffice et nommez-le dans votre demande.
- Un document que vous ouvrez pendant une session peut être modifié à partir de votre message suivant.

## Confidentialité et consommation

- Ce que vous avez masqué pour l’IA ne reste masqué que lorsque l’application lit pour l’agent un document ouvert dans GenOffice. Les fichiers que l’agent lit lui-même dans le dossier sont envoyés tels quels.
- Les termes des recherches web et les adresses des pages lues sont transmis à l’entreprise qui édite le programme et à ces sites. Quand l’accès à Internet pour les commandes de Codex est activé, des données peuvent partir partout où une commande se connecte.
- L’agent travaille en de nombreuses étapes : il consomme donc davantage la limite de votre abonnement que le panneau IA. Quand la limite est atteinte, la demande échoue ; l’agent ne passe jamais à une autre IA ni à une connexion payante.

## En cas de problème

| Ce qu’indique la fenêtre                              | Que faire                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------- |
| **Non connecté**                                      | Connectez-vous à ce programme dans **Paramètres ▸ IA**.             |
| **Ce dossier ne peut pas être utilisé**               | Choisissez un dossier qui ne contient que vos documents de travail. |
| **Codex ne peut pas ouvrir sur ce PC le bac à sable** | Mettez Windows à jour ou choisissez Claude Code.                    |
| **La limite de votre abonnement est atteinte**        | Renvoyez la demande une fois la limite réinitialisée.               |
| **Le programme est trop ancien pour le mode agent**   | Mettez ce programme à jour, puis cliquez sur **Nouvelle session**.  |
