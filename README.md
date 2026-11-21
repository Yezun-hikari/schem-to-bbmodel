# Schematic → bbmodel

Kleines Web-Tool, das Minecraft-Schematics in Blockbench-Modelle (`.bbmodel`, Format **Java Block/Item**) für Ressourcenpakete umwandelt. Läuft komplett im Browser, kein Server nötig.

**Unterstützte Dateien:** `.schem` (Sponge v1–v3, WorldEdit/FAWE), `.litematic` (Litematica, alle Regionen), `.nbt` (Strukturblock), `.schematic` (MCEdit/alt, numerische IDs vor 1.13).

## Benutzung

1. Seite öffnen, Datei(en) in das Feld ziehen oder anklicken.
2. **Minecraft-Version** wählen: daraus kommen Blockstates, Blockmodelle und Texturen (1.13.2 bis 1.21.11).
3. **Blockbench-Formatversion**: entspricht dem Versionsbereich, den Blockbench beim Java-Block/Item-Projekt abfragt (`1.9 – 1.21.5`, `1.21.6 – 1.21.10`, `1.21.11 – 26.2`, `26.3+`). Wird passend zur gewählten Version vorbelegt.
4. Die `.bbmodel` wird heruntergeladen und lässt sich direkt in Blockbench öffnen.

Optionen:

- **Nur Durchschnittsfarbe pro Block** (Standard: an): Jeder Block bekommt statt der Texturen eine einzige Farbe, gemittelt über alle seine Texturen. Volle Blöcke teilen sich eine einfarbige Textur (`<block>_avg.png`). Würfelförmige Blöcke mit Transparenz (Glas, Scheiben, Laub, Eis) werden einheitlich durchscheinend mit der mittleren Deckkraft. Andere Formen (Fackeln, Blumen) behalten ihre Alpha-Maske, sonst ginge ihre Silhouette verloren. Außerdem werden gleiche volle Blöcke zu großen Quadern zusammengefasst (Greedy Meshing). Bereiche, die man von außen nie sieht (verdeckte Blöcke, eingeschlossene Hohlräume hinter undurchsichtigen Wänden), dürfen dabei beliebig mit aufgefüllt werden. Das senkt die Würfelzahl stark und hält Blockbench flüssig.
- **Voxel-Modus** (Standard: aus): Blöcke, die mindestens die Hälfte ihres Raums füllen (Treppen, Stufen …), werden zu vollen Würfeln und mit Nachbarn zusammengefasst. Dünne Formen wie Fackeln, Zäune, Türen und Blumen bleiben erhalten. Schaltet automatisch die Durchschnittsfarbe ein.
- **Detailstufe** (Standard: voll): Verlustbehaftet. Je k×k×k Blöcke werden zu einem Block, und zwar zum häufigsten Nicht-Luft-Block der Zelle. Die Zelle bleibt Luft, wenn weniger als ein Viertel davon gefüllt ist. So bleiben 1 Block dicke Wände bis k = 4 erhalten. Lohnt sich bei großen Bauten, die beim Einpassen ohnehin unter 1 Pixel pro Block schrumpfen. „Auto“ nimmt die kleinste Stufe mit höchstens 2000 Würfeln (maximal 1/4). Ohne Einpassen wird das Modell k-mal kleiner.
- **In 3×3×3 Blöcke einpassen**: Java-Modelle dürfen nur von −16 bis 32 reichen. Größere Bauten werden herunterskaliert.
- **Biomfarben einbacken**: Gras und Laub sind in Vanilla grau und werden erst im Spiel eingefärbt. Mit der Option werden sie grün eingefärbt und als `*_tinted.png` benannt. Diese Texturen musst du beim Export mit ins Pack speichern.

## Grenzen

- Blöcke ohne Blockmodell (Truhen, Schilder, Betten, Banner, Köpfe, Wasser, Lava) werden übersprungen und in der Meldung aufgelistet.
- Bei Blockstates mit Zufallsvarianten wird immer die erste Variante genommen.
- `uvlock` wird angenähert (Textur weltausgerichtet über die Würfelkanten).
- Mod-Blöcke werden übersprungen.
- Sehr große Schematics erzeugen viele Würfel. Ab einigen tausend wird Blockbench träge.

## GitHub Pages

Repository auf GitHub pushen, dann unter **Settings → Pages** als Quelle `Deploy from a branch`, Branch `main`, Ordner `/ (root)` wählen. Kein Build-Schritt nötig.

## Entwicklung

```bash
node test/selfcheck.mjs
```

Der Selbsttest baut kleine `.schem`/`.litematic`-Dateien, konvertiert sie mit echten Vanilla-Assets (Netzwerk nötig) und schreibt `test/sample.schem` zum manuellen Testen.

Vanilla-Assets kommen über jsDelivr aus [InventivetalentDev/minecraft-assets](https://github.com/InventivetalentDev/minecraft-assets), die Zuordnung alter Block-IDs aus [PrismarineJS/minecraft-data](https://github.com/PrismarineJS/minecraft-data).
