import type {
  ProfessionSeed,
  ProfessionTaxonomyReleaseSeed,
  ServiceSeed,
  TaxonomyAliasSeed,
} from "./model.js";

type ServiceDefinition = readonly [
  key: string,
  label: string,
  aliases: readonly string[],
];
type ProfessionDefinition = Readonly<{
  aliases: readonly string[];
  key: string;
  label: string;
  services: readonly ServiceDefinition[];
}>;

const ALL_DEFINITIONS: readonly ProfessionDefinition[] = [
  p(
    "ELECTRICIAN",
    "Elektrikár",
    ["elektro", "elektroinštalatér", "elektromontér", "elektrik"],
    [
      s("ELECTRICAL_INSTALLATION", "Elektroinštalácia", [
        "elektrické rozvody",
        "elektro rozvody",
      ]),
      s("ELECTRICAL_RECONSTRUCTION", "Rekonštrukcia elektroinštalácie", [
        "prerábka elektriny",
        "výmena elektrických rozvodov",
      ]),
      s("SOCKET_SWITCH_INSTALLATION", "Montáž zásuviek a vypínačov", [
        "zásuvky",
        "vypínače",
      ]),
      s("LIGHTING_INSTALLATION", "Montáž osvetlenia", [
        "svetlá",
        "zapojenie lustra",
      ]),
    ],
  ),
  p(
    "PLUMBER",
    "Vodoinštalatér",
    ["vodár", "vodar", "inštalatér vody", "voda servis"],
    [
      s("WATER_INSTALLATION", "Vodoinštalácia", [
        "rozvody vody",
        "vodovodné rozvody",
      ]),
      s("PIPE_REPAIR", "Oprava vodovodného potrubia", [
        "prasknuté potrubie",
        "únik vody",
      ]),
      s("SANITARY_INSTALLATION", "Montáž sanity", [
        "montáž wc",
        "umývadlo montáž",
      ]),
      s("DRAIN_CLEANING", "Čistenie odpadu", ["upchatý odpad", "krtkovanie"]),
    ],
  ),
  p(
    "HEATING_ENGINEER",
    "Kúrenár",
    ["kurenar", "technik kúrenia", "vykurovanie"],
    [
      s("HEATING_INSTALLATION", "Montáž vykurovania", [
        "rozvody kúrenia",
        "nové kúrenie",
      ]),
      s("RADIATOR_INSTALLATION", "Montáž a výmena radiátorov", [
        "radiátory",
        "výmena radiátora",
      ]),
      s("BOILER_SERVICE", "Servis kotla", ["oprava kotla", "kotol servis"]),
      s("FLOOR_HEATING", "Podlahové kúrenie", [
        "podlahovka",
        "montáž podlahového kúrenia",
      ]),
    ],
  ),
  p(
    "GAS_FITTER",
    "Plynár",
    ["plynar", "plynoinštalatér", "plyn servis"],
    [
      s("GAS_INSTALLATION", "Plynoinštalácia", [
        "rozvody plynu",
        "plynové potrubie",
      ]),
      s("GAS_APPLIANCE_CONNECTION", "Pripojenie plynového spotrebiča", [
        "zapojenie sporáka",
        "plynový spotrebič",
      ]),
      s("GAS_LEAK_REPAIR", "Oprava úniku plynu", [
        "uniká plyn",
        "netesnosť plynu",
      ]),
      s("GAS_INSTALLATION_CHECK", "Kontrola plynovej inštalácie", [
        "kontrola plynu",
        "skúška tesnosti plynu",
      ]),
    ],
  ),
  p(
    "MASON",
    "Murár",
    ["murar", "murárske práce", "murovanie"],
    [
      s("BRICKLAYING", "Murovanie stien", [
        "murovanie priečky",
        "tehlová stena",
      ]),
      s("WALL_REPAIR", "Oprava muriva", ["oprava steny", "praskliny v murive"]),
      s("CHIMNEY_WALLING", "Murovanie komína", [
        "stavba komína",
        "komín z tvárnic",
      ]),
      s("CONSTRUCTION_OPENINGS", "Úprava stavebných otvorov", [
        "otvor v stene",
        "zamurovanie dverí",
      ]),
    ],
  ),
  p(
    "CARPENTER_CONSTRUCTION",
    "Tesár",
    ["tesar", "tesárske práce", "krovár"],
    [
      s("ROOF_TRUSS", "Výroba a montáž krovu", ["krov", "nový krov"]),
      s("WOODEN_CANOPY", "Drevený prístrešok", [
        "prístrešok z dreva",
        "carport drevo",
      ]),
      s("PERGOLA_CONSTRUCTION", "Drevená pergola", [
        "pergola",
        "montáž pergoly",
      ]),
      s("WOODEN_STAIRS_STRUCTURE", "Drevené schodisko", [
        "schody z dreva",
        "výroba schodov",
      ]),
    ],
  ),
  p(
    "CONCRETE_WORKER",
    "Betonár",
    ["betonar", "betonárske práce", "železiar betonár"],
    [
      s("FOUNDATION_CONCRETE", "Betónovanie základov", [
        "základy betón",
        "základová doska",
      ]),
      s("CONCRETE_SLAB", "Betónová doska", ["liatie dosky", "betónová platňa"]),
      s("REINFORCED_CONCRETE", "Železobetónové konštrukcie", [
        "železobetón",
        "armovanie betónu",
      ]),
      s("CONCRETE_REPAIR", "Oprava betónu", [
        "sanácia betónu",
        "prasknutý betón",
      ]),
    ],
  ),
  p(
    "DRYWALL_INSTALLER",
    "Sadrokartonista",
    ["sadrokartón", "sadros", "sdk", "sadrokartonár"],
    [
      s("DRYWALL_INSTALLATION", "Montáž sadrokartónu", [
        "sdk montáž",
        "sadros montáž",
      ]),
      s("DRYWALL_CEILING", "Sadrokartónový strop", [
        "sdk strop",
        "znížený strop",
      ]),
      s("DRYWALL_PARTITION", "Sadrokartónová priečka", [
        "sdk priečka",
        "priečka sadrokartón",
      ]),
      s("ATTIC_DRYWALL", "Sadrokartón v podkroví", [
        "sdk podkrovie",
        "obklad podkrovia",
      ]),
    ],
  ),
  p(
    "PAINTER",
    "Maliar",
    ["maliar izieb", "maľovanie", "malovanie", "natierač"],
    [
      s("INTERIOR_PAINTING", "Maľovanie interiéru", [
        "maľovanie bytu",
        "maľovanie izieb",
      ]),
      s("EXTERIOR_PAINTING", "Maľovanie exteriéru", [
        "náter fasády",
        "vonkajšie maľovanie",
      ]),
      s("WALL_PREPARATION", "Príprava stien pred maľovaním", [
        "stierkovanie pred maľovaním",
        "penetrácia stien",
      ]),
      s("WOOD_METAL_PAINTING", "Nátery dreva a kovu", [
        "natieranie plotu",
        "náter dreva",
      ]),
    ],
  ),
  p(
    "WALLPAPER_INSTALLER",
    "Tapetár",
    ["tapetar", "tapetovanie", "lepenie tapiet"],
    [
      s("WALLPAPER_INSTALLATION", "Lepenie tapiet", [
        "tapetovanie stien",
        "montáž tapety",
      ]),
      s("WALLPAPER_REMOVAL", "Odstránenie tapiet", [
        "strhávanie tapiet",
        "dať dole tapety",
      ]),
      s("PHOTO_WALLPAPER", "Montáž fototapety", [
        "fototapeta",
        "nalepenie fototapety",
      ]),
      s("WALLPAPER_SURFACE_PREP", "Príprava podkladu pod tapety", [
        "stena pod tapetu",
        "penetrácia pod tapetu",
      ]),
    ],
  ),
  p(
    "TILER",
    "Obkladač",
    ["obklady", "obkladac", "obkladač dlaždič", "kachličkár"],
    [
      s("BATHROOM_TILING", "Obkladanie kúpeľne", [
        "obklad kúpeľne",
        "kachličky kúpeľňa",
      ]),
      s("FLOOR_TILING", "Pokládka dlažby", ["dlažba", "dláždenie interiéru"]),
      s("LARGE_FORMAT_TILING", "Veľkoformátový obklad", [
        "veľký formát dlažby",
        "large format obklad",
      ]),
      s("TILE_REPAIR", "Oprava obkladu a dlažby", [
        "výmena kachličky",
        "oprava dlaždice",
      ]),
    ],
  ),
  p(
    "FLOOR_INSTALLER",
    "Podlahár",
    ["podlahar", "podlahy", "pokladač podláh"],
    [
      s("LAMINATE_FLOOR", "Pokládka laminátovej podlahy", [
        "laminát",
        "plávajúca podlaha",
      ]),
      s("VINYL_FLOOR", "Pokládka vinylovej podlahy", [
        "vinyl",
        "pokladač vinylu",
      ]),
      s("WOOD_FLOOR", "Pokládka drevenej podlahy", [
        "drevené parkety",
        "masívna podlaha",
      ]),
      s("FLOOR_RENOVATION", "Renovácia podlahy", [
        "brúsenie parkiet",
        "oprava parkiet",
      ]),
    ],
  ),
  p(
    "JOINER",
    "Stolár",
    ["stolar", "stolárstvo", "práca s drevom"],
    [
      s("CUSTOM_FURNITURE", "Nábytok na mieru", [
        "výroba nábytku",
        "nábytok podľa rozmeru",
      ]),
      s("BUILTIN_WARDROBE", "Vstavaná skriňa", [
        "skriňa na mieru",
        "rolldor skriňa",
      ]),
      s("WOODEN_DOOR", "Výroba drevených dverí", [
        "dvere na mieru",
        "masívne dvere",
      ]),
      s("WOOD_REPAIR", "Oprava drevených výrobkov", [
        "oprava nábytku",
        "oprava dreva",
      ]),
    ],
  ),
  p(
    "KITCHEN_INSTALLER",
    "Montážnik kuchýň",
    ["kuchyniar", "montáž kuchyne", "kuchynské linky"],
    [
      s("KITCHEN_ASSEMBLY", "Montáž kuchynskej linky", [
        "zloženie kuchyne",
        "osadenie kuchyne",
      ]),
      s("WORKTOP_INSTALLATION", "Montáž pracovnej dosky", [
        "kuchynská doska",
        "výrez pracovnej dosky",
      ]),
      s("KITCHEN_APPLIANCE_INSTALL", "Osadenie kuchynských spotrebičov", [
        "vstavané spotrebiče",
        "osadenie rúry",
      ]),
      s("KITCHEN_ADJUSTMENT", "Úprava kuchynskej linky", [
        "oprava kuchyne",
        "úprava skriniek",
      ]),
    ],
  ),
  p(
    "ROOFER",
    "Strechár",
    ["strechar", "strechy", "pokrývač"],
    [
      s("ROOF_COVERING", "Montáž strešnej krytiny", [
        "strešná krytina",
        "pokládka škridly",
      ]),
      s("ROOF_REPAIR", "Oprava strechy", ["zateká strecha", "oprava krytiny"]),
      s("FLAT_ROOF", "Realizácia plochej strechy", [
        "plochá strecha",
        "hydroizolácia strechy",
      ]),
      s("ROOF_WINDOW", "Montáž strešného okna", [
        "strešné okno",
        "velux montáž",
      ]),
    ],
  ),
  p(
    "SHEET_METAL_WORKER",
    "Klampiar",
    ["klampiarstvo", "klampiarske práce", "oplechovanie"],
    [
      s("GUTTER_INSTALLATION", "Montáž odkvapov", ["odkvapy", "žľaby"]),
      s("ROOF_FLASHING", "Oplechovanie strechy", [
        "oplechovanie komína",
        "strešný plech",
      ]),
      s("GUTTER_REPAIR", "Oprava odkvapov", ["tečúci odkvap", "oprava žľabu"]),
      s("SHEET_METAL_ROOF", "Plechová strecha", [
        "montáž plechovej strechy",
        "strešný plech",
      ]),
    ],
  ),
  p(
    "CHIMNEY_SWEEP",
    "Kominár",
    ["kominar", "komíny", "čistenie komína"],
    [
      s("CHIMNEY_CLEANING", "Čistenie komína", [
        "vymetanie komína",
        "komín čistenie",
      ]),
      s("CHIMNEY_INSPECTION", "Kontrola komína", [
        "prehliadka komína",
        "kontrola spalinovej cesty",
      ]),
      s("CHIMNEY_LINING", "Vložkovanie komína", [
        "komínová vložka",
        "nerezová vložka komína",
      ]),
      s("CHIMNEY_REPAIR", "Oprava komína", [
        "sanácia komína",
        "oprava komínovej hlavy",
      ]),
    ],
  ),
  p(
    "WINDOW_DOOR_INSTALLER",
    "Montážnik okien a dverí",
    ["oknár", "dverár", "montáž okien"],
    [
      s("WINDOW_INSTALLATION", "Montáž okien", [
        "osadenie okna",
        "výmena okien",
      ]),
      s("EXTERIOR_DOOR_INSTALL", "Montáž vchodových dverí", [
        "vchodové dvere",
        "osadenie dverí",
      ]),
      s("INTERIOR_DOOR_INSTALL", "Montáž interiérových dverí", [
        "izbové dvere",
        "zárubne",
      ]),
      s("WINDOW_ADJUSTMENT", "Servis a nastavenie okien", [
        "nastavenie okna",
        "tesnenie okien",
      ]),
    ],
  ),
  p(
    "GLAZIER",
    "Sklenár",
    ["sklenar", "sklenárstvo", "sklo na mieru"],
    [
      s("WINDOW_GLASS_REPLACE", "Výmena okenného skla", [
        "rozbité okno",
        "výmena skla",
      ]),
      s("SHOWER_GLASS", "Sklenený sprchový kút", [
        "sklo do sprchy",
        "sprchová zástena",
      ]),
      s("GLASS_RAILING", "Sklenené zábradlie", [
        "zábradlie zo skla",
        "bezpečnostné sklo",
      ]),
      s("MIRROR_INSTALLATION", "Výroba a montáž zrkadla", [
        "zrkadlo na mieru",
        "lepenie zrkadla",
      ]),
    ],
  ),
  p(
    "LOCKSMITH",
    "Zámočník",
    ["zamocnik", "zámočníctvo", "kovovýroba"],
    [
      s("METAL_GATE", "Výroba kovovej brány", [
        "brána na mieru",
        "železná brána",
      ]),
      s("METAL_RAILING", "Výroba kovového zábradlia", [
        "železné zábradlie",
        "zábradlie na mieru",
      ]),
      s("LOCK_REPAIR", "Oprava a výmena zámku", [
        "pokazený zámok",
        "výmena vložky",
      ]),
      s("METAL_STRUCTURE", "Kovové konštrukcie", [
        "oceľová konštrukcia",
        "kovový rám",
      ]),
    ],
  ),
  p(
    "WELDER",
    "Zvárač",
    ["zvarac", "zváranie", "zváračské práce"],
    [
      s("STEEL_WELDING", "Zváranie ocele", ["zváranie železa", "oceľový zvar"]),
      s("STAINLESS_WELDING", "Zváranie nerezu", [
        "nerez zváranie",
        "tig nerez",
      ]),
      s("ALUMINIUM_WELDING", "Zváranie hliníka", [
        "hliník zváranie",
        "tig hliník",
      ]),
      s("WELD_REPAIR", "Oprava zváraním", [
        "zvariť prasklinu",
        "oprava kovu zváraním",
      ]),
    ],
  ),
  p(
    "BLACKSMITH",
    "Kováč",
    ["kovac", "kováčstvo", "umelecký kováč"],
    [
      s("FORGED_GATE", "Kovaná brána", ["brána kovaná", "umelecká brána"]),
      s("FORGED_RAILING", "Kované zábradlie", [
        "zábradlie kované",
        "umelecké zábradlie",
      ]),
      s("FORGED_FURNITURE", "Kovaný nábytok", ["kovaný stôl", "kovaná lavica"]),
      s("FORGED_REPAIR", "Oprava kovaných prvkov", [
        "oprava kovania",
        "renovácia kovanej brány",
      ]),
    ],
  ),
  p(
    "SHADING_INSTALLER",
    "Montážnik tieniacej techniky",
    ["žalúzie", "rolety", "tienenie"],
    [
      s("BLINDS_INSTALLATION", "Montáž žalúzií", [
        "žalúzie montáž",
        "vnútorné žalúzie",
      ]),
      s("ROLLER_SHUTTER", "Montáž roliet", [
        "okenné rolety",
        "vonkajšie rolety",
      ]),
      s("AWNING_INSTALLATION", "Montáž markízy", [
        "markíza",
        "terasa tienenie",
      ]),
      s("SHADING_REPAIR", "Servis tieniacej techniky", [
        "oprava žalúzií",
        "oprava rolety",
      ]),
    ],
  ),
  p(
    "FACADE_WORKER",
    "Fasádnik",
    ["fasadnik", "fasády", "zatepľovač"],
    [
      s("FACADE_INSULATION", "Zateplenie fasády", [
        "zateplenie domu",
        "polystyrén fasáda",
      ]),
      s("FACADE_PLASTER", "Fasádna omietka", [
        "omietka fasády",
        "farebná fasáda",
      ]),
      s("FACADE_REPAIR", "Oprava fasády", [
        "praskliny fasády",
        "sanácia fasády",
      ]),
      s("FACADE_CLADDING", "Fasádny obklad", [
        "obklad domu",
        "odvetraná fasáda",
      ]),
    ],
  ),
  p(
    "INSULATION_WORKER",
    "Izolatér",
    ["izolater", "izolácie", "hydroizolatér"],
    [
      s("WATERPROOFING", "Hydroizolácia", [
        "izolácia proti vode",
        "hydro izolácia",
      ]),
      s("BASEMENT_INSULATION", "Izolácia suterénu", [
        "izolácia pivnice",
        "vlhká pivnica",
      ]),
      s("TERRACE_WATERPROOFING", "Hydroizolácia terasy", [
        "tečie terasa",
        "izolácia balkóna",
      ]),
      s("THERMAL_INSULATION", "Tepelná izolácia", [
        "zateplenie stropu",
        "minerálna vlna",
      ]),
    ],
  ),
  p(
    "PLASTERER",
    "Omietkar",
    ["omietky", "omietkar", "strojové omietky"],
    [
      s("INTERIOR_PLASTER", "Vnútorné omietky", [
        "omietanie stien",
        "jadrová omietka",
      ]),
      s("MACHINE_PLASTER", "Strojové omietky", [
        "strojová omietka",
        "sadrové omietky",
      ]),
      s("DECORATIVE_PLASTER", "Dekoratívna omietka", [
        "benátsky štuk",
        "dekor omietka",
      ]),
      s("PLASTER_REPAIR", "Oprava omietky", [
        "opadaná omietka",
        "lokálna oprava steny",
      ]),
    ],
  ),
  p(
    "DEMOLITION_WORKER",
    "Pracovník búracích prác",
    ["búracie práce", "buracie prace", "demolácia"],
    [
      s("INTERIOR_DEMOLITION", "Búranie priečok a interiéru", [
        "vybúranie priečky",
        "demontáž jadra",
      ]),
      s("FLOOR_REMOVAL", "Odstránenie podlahy", [
        "vybúranie podlahy",
        "strhnutie dlažby",
      ]),
      s("BUILDING_DEMOLITION", "Demolácia stavby", [
        "zbúranie domu",
        "búranie objektu",
      ]),
      s("RUBBLE_REMOVAL", "Odvoz stavebnej sute", [
        "odvoz sutiny",
        "likvidácia sute",
      ]),
    ],
  ),
  p(
    "EARTHWORK_OPERATOR",
    "Strojník zemných prác",
    ["bagerista", "výkopové práce", "zemné práce"],
    [
      s("FOUNDATION_EXCAVATION", "Výkop základov", [
        "kopanie základov",
        "výkop pre dom",
      ]),
      s("UTILITY_TRENCH", "Výkop ryhy pre prípojky", [
        "ryha na kábel",
        "výkop kanalizácie",
      ]),
      s("TERRAIN_GRADING", "Úprava a zarovnanie terénu", [
        "zrovnanie pozemku",
        "planírovanie",
      ]),
      s("MINI_EXCAVATOR", "Práce minibagrom", ["minibager", "malý bager"]),
    ],
  ),
  p(
    "PAVER",
    "Dlaždič",
    ["dlazdic", "zámková dlažba", "pokladač dlažby"],
    [
      s("PAVING_BLOCKS", "Pokládka zámkovej dlažby", [
        "zámkovka",
        "dlažba chodník",
      ]),
      s("CURB_INSTALLATION", "Osadenie obrubníkov", [
        "obrubníky",
        "cestný obrubník",
      ]),
      s("PATIO_PAVING", "Dlažba terasy", ["terasa dlažba", "vonkajšia dlažba"]),
      s("PAVING_REPAIR", "Oprava vonkajšej dlažby", [
        "prepadnutá dlažba",
        "oprava zámkovky",
      ]),
    ],
  ),
  p(
    "GARDENER",
    "Záhradník",
    ["zahradnik", "záhrada", "údržba záhrady"],
    [
      s("GARDEN_DESIGN", "Návrh a realizácia záhrady", [
        "záhrada na kľúč",
        "založenie záhrady",
      ]),
      s("LAWN_INSTALLATION", "Založenie trávnika", [
        "siaty trávnik",
        "trávnik koberec",
      ]),
      s("GARDEN_MAINTENANCE", "Údržba záhrady", [
        "strihanie záhrady",
        "starostlivosť o záhradu",
      ]),
      s("IRRIGATION", "Závlahový systém", [
        "automatická závlaha",
        "polievanie záhrady",
      ]),
    ],
  ),
  p(
    "ARBORIST",
    "Arborista",
    ["stromolezec", "ošetrenie stromov", "rizikové pílenie"],
    [
      s("TREE_PRUNING", "Orez stromov", ["strihanie stromu", "zdravotný rez"]),
      s("TREE_FELLING", "Výrub stromu", ["spílenie stromu", "rizikový výrub"]),
      s("STUMP_REMOVAL", "Odstránenie pňa", [
        "frézovanie pňa",
        "vybratie koreňa",
      ]),
      s("TREE_ASSESSMENT", "Posúdenie stavu stromu", [
        "kontrola stromu",
        "arboristický posudok",
      ]),
    ],
  ),
  p(
    "POOL_TECHNICIAN",
    "Bazénový technik",
    ["bazény", "servis bazéna", "bazenar"],
    [
      s("POOL_INSTALLATION", "Montáž bazéna", [
        "osadenie bazéna",
        "bazén na kľúč",
      ]),
      s("POOL_TECHNOLOGY", "Montáž bazénovej technológie", [
        "filtrácia bazéna",
        "čerpadlo bazéna",
      ]),
      s("POOL_SERVICE", "Servis bazéna", ["oprava bazéna", "bazén údržba"]),
      s("POOL_WINTERIZING", "Zazimovanie bazéna", [
        "zima bazén",
        "odzimovanie bazéna",
      ]),
    ],
  ),
  p(
    "HVAC_TECHNICIAN",
    "Technik klimatizácií",
    ["klimatizácia", "klímar", "klima servis"],
    [
      s("AC_INSTALLATION", "Montáž klimatizácie", [
        "klíma montáž",
        "inštalácia klimatizácie",
      ]),
      s("AC_SERVICE", "Servis klimatizácie", [
        "oprava klímy",
        "klimatizácia servis",
      ]),
      s("AC_CLEANING", "Čistenie klimatizácie", [
        "dezinfekcia klímy",
        "čistenie výparníka",
      ]),
      s("MULTISPLIT_AC", "Multisplit klimatizácia", [
        "viac izbová klíma",
        "multi split",
      ]),
    ],
  ),
  p(
    "REFRIGERATION_TECHNICIAN",
    "Chladiar",
    ["chladiarenský technik", "chladenie", "chladiace zariadenia"],
    [
      s("REFRIGERATION_SERVICE", "Servis chladiaceho zariadenia", [
        "oprava chladenia",
        "chladiaci box servis",
      ]),
      s("COLD_ROOM", "Montáž chladiaceho boxu", [
        "chladiaci box",
        "chladiaca miestnosť",
      ]),
      s("REFRIGERANT_CHECK", "Kontrola chladiaceho okruhu", [
        "únik chladiva",
        "doplnenie chladiva",
      ]),
      s("COMMERCIAL_REFRIGERATION", "Komerčné chladenie", [
        "gastro chladenie",
        "vitrína chladenie",
      ]),
    ],
  ),
  p(
    "HEAT_PUMP_TECHNICIAN",
    "Technik tepelných čerpadiel",
    ["tepelné čerpadlá", "čerpadlár", "heat pump"],
    [
      s("HEAT_PUMP_INSTALL", "Montáž tepelného čerpadla", [
        "tepelné čerpadlo montáž",
        "inštalácia čerpadla",
      ]),
      s("HEAT_PUMP_SERVICE", "Servis tepelného čerpadla", [
        "oprava tepelného čerpadla",
        "čerpadlo servis",
      ]),
      s("HEAT_PUMP_SETUP", "Nastavenie tepelného čerpadla", [
        "regulácia čerpadla",
        "spustenie čerpadla",
      ]),
      s("HEAT_PUMP_MAINTENANCE", "Údržba tepelného čerpadla", [
        "prehliadka čerpadla",
        "čistenie čerpadla",
      ]),
    ],
  ),
  p(
    "SOLAR_INSTALLER",
    "Montážnik fotovoltiky",
    ["fotovoltik", "solárnik", "fotovoltika"],
    [
      s("PV_INSTALLATION", "Montáž fotovoltických panelov", [
        "solárne panely",
        "fotovoltické panely",
      ]),
      s("PV_INVERTER", "Montáž a nastavenie meniča", [
        "fotovoltický menič",
        "inverter fotovoltika",
      ]),
      s("PV_BATTERY", "Batériové úložisko", [
        "batéria fotovoltika",
        "domáca batéria",
      ]),
      s("PV_SERVICE", "Servis fotovoltiky", [
        "oprava soláru",
        "kontrola panelov",
      ]),
    ],
  ),
  p(
    "SECURITY_TECHNICIAN",
    "Technik zabezpečovacích systémov",
    ["alarmy", "kamerár", "zabezpečenie domu"],
    [
      s("ALARM_INSTALLATION", "Montáž alarmu", [
        "alarm do domu",
        "zabezpečovačka",
      ]),
      s("CAMERA_INSTALLATION", "Montáž kamerového systému", [
        "kamery",
        "cctv montáž",
      ]),
      s("VIDEO_DOORBELL", "Montáž videovrátnika", [
        "video vrátnik",
        "domový vrátnik",
      ]),
      s("ACCESS_CONTROL", "Prístupový systém", [
        "kontrola vstupu",
        "čipový vstup",
      ]),
    ],
  ),
  p(
    "SMART_HOME_TECHNICIAN",
    "Technik inteligentnej domácnosti",
    ["smart home", "inteligentný dom", "automatizácia domu"],
    [
      s("SMART_HOME_INSTALL", "Montáž inteligentnej domácnosti", [
        "smart elektroinštalácia",
        "automatizácia domácnosti",
      ]),
      s("SMART_LIGHTING", "Inteligentné osvetlenie", [
        "smart svetlá",
        "riadenie osvetlenia",
      ]),
      s("SMART_HEATING", "Inteligentné riadenie kúrenia", [
        "smart termostat",
        "zónová regulácia",
      ]),
      s("SMART_HOME_SERVICE", "Servis inteligentnej domácnosti", [
        "oprava smart home",
        "nastavenie automatizácie",
      ]),
    ],
  ),
  p(
    "APPLIANCE_TECHNICIAN",
    "Servisný technik spotrebičov",
    ["opravár spotrebičov", "biela technika servis", "spotrebiče"],
    [
      s("WASHER_REPAIR", "Oprava práčky", ["pokazená práčka", "práčka servis"]),
      s("DISHWASHER_REPAIR", "Oprava umývačky riadu", [
        "umývačka servis",
        "pokazená umývačka",
      ]),
      s("OVEN_REPAIR", "Oprava rúry a sporáka", [
        "rúra servis",
        "sporák oprava",
      ]),
      s("DRYER_REPAIR", "Oprava sušičky", [
        "sušička servis",
        "pokazená sušička",
      ]),
    ],
  ),
  p(
    "HANDYMAN",
    "Domáci majster",
    ["hodinový manžel", "majster do domu", "drobné opravy"],
    [
      s("FURNITURE_ASSEMBLY", "Montáž nábytku", [
        "skladanie nábytku",
        "ikea montáž",
      ]),
      s("SHELF_INSTALLATION", "Montáž políc a držiakov", [
        "zavesenie police",
        "vŕtanie do steny",
      ]),
      s("CURTAIN_ROD_INSTALL", "Montáž garniže", [
        "garniža",
        "zavesenie záclon",
      ]),
      s("SMALL_HOME_REPAIRS", "Drobné opravy v domácnosti", [
        "opravy v byte",
        "údržbár",
      ]),
    ],
  ),
  p(
    "UPHOLSTERER",
    "Čalúnnik",
    ["calunnik", "čalúnnictvo", "prečalúnenie"],
    [
      s("SOFA_UPHOLSTERY", "Prečalúnenie sedačky", [
        "čalúnenie gauča",
        "oprava sedačky",
      ]),
      s("CHAIR_UPHOLSTERY", "Prečalúnenie stoličky", [
        "čalúnenie stoličiek",
        "oprava kresla",
      ]),
      s("HEADBOARD_UPHOLSTERY", "Čalúnené čelo postele", [
        "čelo postele na mieru",
        "čalúnenie postele",
      ]),
      s("UPHOLSTERY_REPAIR", "Oprava čalúnenia", [
        "poškodené čalúnenie",
        "výmena látky",
      ]),
    ],
  ),
  p(
    "STONE_MASON",
    "Kamenár",
    ["kamenar", "kamenárstvo", "prírodný kameň"],
    [
      s("STONE_WORKTOP", "Kamenná pracovná doska", [
        "žulová doska",
        "kuchynský kameň",
      ]),
      s("STONE_STAIRS", "Kamenné schody", [
        "žulové schody",
        "obklad schodov kameňom",
      ]),
      s("STONE_CLADDING", "Kamenný obklad", [
        "obklad z kameňa",
        "prírodný kameň stena",
      ]),
      s("STONE_RENOVATION", "Renovácia kameňa", [
        "brúsenie mramoru",
        "oprava žuly",
      ]),
    ],
  ),
  p(
    "RESTORER",
    "Reštaurátor",
    ["restaurator", "renovácia historických prvkov", "obnova pamiatok"],
    [
      s("FURNITURE_RESTORATION", "Reštaurovanie nábytku", [
        "obnova starého nábytku",
        "starožitný nábytok oprava",
      ]),
      s("DOOR_RESTORATION", "Reštaurovanie dverí", [
        "obnova starých dverí",
        "historické dvere",
      ]),
      s("WOOD_ELEMENT_RESTORATION", "Obnova drevených prvkov", [
        "renovácia dreva",
        "historické drevo",
      ]),
      s("METAL_ELEMENT_RESTORATION", "Obnova kovových prvkov", [
        "renovácia kovu",
        "historické kovanie",
      ]),
    ],
  ),
  p(
    "VENTILATION_TECHNICIAN",
    "Technik vzduchotechniky",
    ["vzduchotechnika", "vetranie", "rekuperácia"],
    [
      s("VENTILATION_INSTALL", "Montáž vzduchotechniky", [
        "vetracie rozvody",
        "ventilácia domu",
      ]),
      s("RECUPERATION_INSTALL", "Montáž rekuperácie", [
        "rekuperácia domu",
        "riadené vetranie",
      ]),
      s("VENTILATION_CLEANING", "Čistenie vzduchotechniky", [
        "čistenie potrubia vetrania",
        "dezinfekcia vzduchotechniky",
      ]),
      s("VENTILATION_SERVICE", "Servis vzduchotechniky", [
        "oprava rekuperácie",
        "vetranie servis",
      ]),
    ],
  ),
  p(
    "GARAGE_DOOR_TECHNICIAN",
    "Montážnik garážových brán",
    ["garážové brány", "bránar", "servis brány"],
    [
      s("GARAGE_DOOR_INSTALL", "Montáž garážovej brány", [
        "sekčná brána",
        "osadenie garážovej brány",
      ]),
      s("GATE_DRIVE_INSTALL", "Montáž pohonu brány", [
        "motor na bránu",
        "automatická brána",
      ]),
      s("GARAGE_DOOR_SERVICE", "Servis garážovej brány", [
        "oprava brány",
        "brána sa neotvára",
      ]),
      s("GATE_REMOTE_SETUP", "Nastavenie ovládania brány", [
        "ovládač brány",
        "párovanie diaľkového",
      ]),
    ],
  ),
  p(
    "FENCE_INSTALLER",
    "Montážnik plotov",
    ["plotár", "ploty", "oplotenie"],
    [
      s("PANEL_FENCE", "Montáž panelového plotu", [
        "3d plot",
        "pletivové panely",
      ]),
      s("MESH_FENCE", "Montáž pletivového plotu", ["pletivo", "drôtený plot"]),
      s("FENCE_FOUNDATION", "Základ a podmurovka plota", [
        "múrik pod plot",
        "betónovanie plota",
      ]),
      s("FENCE_REPAIR", "Oprava plota", ["poškodený plot", "výmena pletiva"]),
    ],
  ),
  p(
    "SEPTIC_TECHNICIAN",
    "Technik kanalizácií a žúmp",
    ["kanalizácia", "žumpa", "čistička odpadových vôd"],
    [
      s("SEWER_CONNECTION", "Kanalizačná prípojka", [
        "prípojka kanalizácie",
        "napojenie odpadu",
      ]),
      s("SEPTIC_INSTALL", "Montáž žumpy", ["osadenie žumpy", "nádrž na odpad"]),
      s("TREATMENT_PLANT_INSTALL", "Montáž domovej čističky", [
        "čov",
        "domová čistička",
      ]),
      s("SEWER_CAMERA", "Kamerová kontrola kanalizácie", [
        "kamera do odpadu",
        "monitoring kanalizácie",
      ]),
    ],
  ),
  p(
    "FIREPLACE_BUILDER",
    "Krbár",
    ["krbar", "krby", "kachliar"],
    [
      s("FIREPLACE_BUILD", "Stavba krbu", ["krb na mieru", "murovaný krb"]),
      s("STOVE_INSTALL", "Montáž krbových kachlí", [
        "krbové kachle",
        "zapojenie kachlí",
      ]),
      s("FIREPLACE_INSERT", "Montáž krbovej vložky", [
        "krbová vložka",
        "osadenie vložky",
      ]),
      s("FIREPLACE_REPAIR", "Oprava a servis krbu", [
        "oprava krbu",
        "krb servis",
      ]),
    ],
  ),
  p(
    "SOLAR_THERMAL_INSTALLER",
    "Montážnik solárnych kolektorov",
    ["solárny ohrev", "termický solár", "solárne kolektory"],
    [
      s("SOLAR_THERMAL_INSTALL", "Montáž solárnych kolektorov", [
        "kolektory na vodu",
        "solárny systém",
      ]),
      s("SOLAR_THERMAL_SERVICE", "Servis solárneho ohrevu", [
        "oprava kolektorov",
        "solár servis",
      ]),
      s("SOLAR_TANK_CONNECT", "Pripojenie solárneho zásobníka", [
        "solárny bojler",
        "zásobník teplej vody",
      ]),
      s("SOLAR_FLUID_CHANGE", "Výmena kvapaliny v solárnom systéme", [
        "glykol solár",
        "náplň kolektorov",
      ]),
    ],
  ),
] as const;

// The approved V1 target is intentionally bounded. The remaining reviewed
// definitions stay in source as candidates for the next governed release,
// without silently expanding the initial marketplace vocabulary.
const DEFINITIONS = Object.freeze(ALL_DEFINITIONS.slice(0, 45));

export interface ManagedCatalogReleaseIdentity {
  readonly includeSyntheticFixture?: boolean;
  readonly releaseId: string;
  readonly supersedesReleaseId: string | null;
  readonly version: number;
}

export function createManagedCatalogV1Release(
  identity: ManagedCatalogReleaseIdentity,
): ProfessionTaxonomyReleaseSeed {
  const professions: ProfessionSeed[] = DEFINITIONS.map((definition) => ({
    code: `PROF:${definition.key}`,
    descriptionSk: `Odborná rola pre práce v oblasti ${definition.label.toLocaleLowerCase("sk-SK")}.`,
    labelSk: definition.label,
    replacedByCode: null,
    slug: slugify(definition.label),
    state: "ACTIVE",
  }));
  if (identity.includeSyntheticFixture === true) {
    professions.push({
      code: "PROF:ALPHA_SYNTHETIC",
      descriptionSk: "Výhradne syntetická stagingová testovacia položka.",
      labelSk: "Syntetické testovacie remeslo",
      replacedByCode: null,
      slug: "synteticke-testovacie-remeslo",
      state: "ACTIVE",
    });
  }
  const services: ServiceSeed[] = DEFINITIONS.flatMap((definition) =>
    definition.services.map(([key, label]) => ({
      code: `SERV:${key}`,
      descriptionSk: `Konkrétna služba: ${label}.`,
      labelSk: label,
      primaryProfessionCode: `PROF:${definition.key}`,
      professionCodes: [`PROF:${definition.key}`],
      replacedByCode: null,
      slug: slugify(label),
      state: "ACTIVE",
    })),
  );
  const aliases: TaxonomyAliasSeed[] = [];
  for (const definition of DEFINITIONS) {
    addAliases(
      aliases,
      "PROFESSION",
      `PROF:${definition.key}`,
      definition.aliases,
    );
    for (const [key, , serviceAliases] of definition.services) {
      addAliases(aliases, "SERVICE", `SERV:${key}`, serviceAliases);
    }
  }
  const canonicalSlugByCode = new Map<string, string>([
    ...professions.map((item) => [item.code, item.slug] as const),
    ...services.map((item) => [item.code, item.slug] as const),
  ]);
  const canonicalSlugs = new Set(canonicalSlugByCode.values());
  return {
    aliases: aliases.filter((alias) => !canonicalSlugs.has(alias.alias)),
    capabilityCriteria: [],
    contentClass: "CANONICAL",
    professions,
    releaseId: identity.releaseId,
    reviewReference: "product-decision:managed-catalog-v1/2026-10-01",
    reviewState: "HUMAN_REVIEW_APPROVED",
    services,
    specializations: [],
    supersedesReleaseId: identity.supersedesReleaseId,
    version: identity.version,
  };
}

function p(
  key: string,
  label: string,
  aliases: readonly string[],
  services: readonly ServiceDefinition[],
): ProfessionDefinition {
  return { aliases, key, label, services };
}

function s(
  key: string,
  label: string,
  aliases: readonly string[],
): ServiceDefinition {
  return [key, label, aliases];
}

function addAliases(
  target: TaxonomyAliasSeed[],
  targetKind: "PROFESSION" | "SERVICE",
  targetCode: string,
  values: readonly string[],
): void {
  const seen = new Set<string>();
  for (const value of values) {
    const alias = slugify(value);
    if (seen.has(alias)) continue;
    seen.add(alias);
    target.push({
      alias,
      kind: "SEARCH_TERM",
      targetCode,
      targetKind,
    });
  }
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("sk-SK")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}
