/**
 * DNN ID formatter — Capitalizes DNN IDs for display.
 *
 * Format: n + Word1 + Word2 + SUFFIX
 * Where: 'n' stays lowercase, words are Title Case, suffix is UPPERCASE.
 *
 * Word boundaries are detected via a 4-char prefix → word-length map
 * derived from the DNN BIP39 wordlist (1999 words, unique 4-char prefixes).
 */

// Prefix → full word length map (4-char prefix for 5+ letter words, full word for 3-4 letter words)
const W=new Map<string,number>([
['aban',7],['abil',7],['able',4],['abou',5],['abov',5],['abse',6],['abso',6],['abst',8],
['absu',6],['abus',5],['acce',6],['acci',8],['acco',7],['accu',6],['achi',7],['acid',4],
['acou',8],['acqu',7],['acro',6],['acti',6],['acto',5],['actr',7],['actu',6],['adap',5],
['addi',6],['addr',7],['adju',6],['admi',5],['adul',5],['adva',7],['advi',6],['aero',7],
['affa',6],['affo',6],['afra',6],['agai',5],['agen',5],['agre',5],['ahea',5],['aim',3],
['airp',7],['aisl',5],['alar',5],['albu',5],['alco',7],['aler',5],['alie',5],['alle',5],
['allo',5],['almo',6],['alon',5],['alph',5],['alre',7],['also',4],['alte',5],['alwa',6],
['amat',7],['amaz',7],['amon',5],['amou',6],['amus',6],['anal',7],['anch',6],['anci',7],
['ange',5],['angl',5],['angr',5],['anim',6],['ankl',5],['anno',8],['annu',6],['anot',7],
['answ',6],['ante',7],['anti',7],['anxi',7],['any',3],['apar',5],['apol',7],['appe',6],
['appl',5],['appr',7],['apri',5],['arch',4],['arct',6],['area',4],['aren',5],['argu',5],
['arme',5],['armo',5],['army',4],['arou',6],['arra',7],['arre',6],['arri',6],['arro',5],
['arte',8],['arti',6],['artw',7],['ask',3],['aspe',6],['assa',7],['asse',5],['assi',6],
['assu',6],['asth',6],['athl',7],['atom',4],['atta',6],['atte',6],['atti',8],['attr',7],
['auct',7],['audi',5],['augu',6],['aunt',4],['auth',6],['auto',4],['autu',6],['aver',7],
['avoc',7],['avoi',5],['awak',5],['awar',5],['away',4],['awes',7],['awfu',5],['awkw',7],
['axis',4],['baby',4],['bach',8],['baco',5],['badg',5],['bag',3],['bala',7],['balc',7],
['ball',4],['bamb',6],['bana',6],['bann',6],['bare',6],['barg',7],['barr',6],['base',4],
['basi',5],['bask',6],['batt',6],['beac',5],['bean',4],['beau',6],['beca',7],['beco',6],
['beef',4],['befo',6],['begi',5],['beha',6],['behi',6],['beli',7],['belo',5],['belt',4],
['benc',5],['bene',7],['best',4],['betr',6],['bett',6],['betw',7],['beyo',6],['bicy',7],
['bid',3],['bike',4],['bind',4],['biol',7],['bird',4],['birt',5],['bitt',6],['blac',5],
['blad',5],['blam',5],['blan',7],['blas',5],['blea',5],['bles',5],['blin',5],['bloo',5],
['blos',7],['blou',6],['blue',4],['blur',4],['blus',5],['boar',5],['boat',4],['body',4],
['boil',4],['bomb',4],['bone',4],['bonu',5],['book',4],['boos',5],['bord',6],['bori',6],
['borr',6],['boss',4],['bott',6],['boun',6],['box',3],['boy',3],['brac',7],['brai',5],
['bran',5],['bras',5],['brav',5],['brea',5],['bree',6],['bric',5],['brid',6],['brie',5],
['brig',6],['brin',5],['bris',5],['broc',8],['brok',6],['bron',6],['broo',5],['brot',7],
['brow',5],['brus',5],['bubb',6],['budd',5],['budg',6],['buff',7],['buil',5],['bulb',4],
['bulk',4],['bull',6],['bund',6],['bunk',6],['burd',6],['burg',6],['burs',5],['busi',8],
['busy',4],['butt',6],['buye',5],['buzz',4],['cabb',7],['cabi',5],['cabl',5],['cact',6],
['cage',4],['cake',4],['call',4],['calm',4],['came',6],['camp',4],['cana',5],['canc',6],
['cand',5],['cann',6],['cano',5],['canv',6],['cany',6],['capa',7],['capi',7],['capt',7],
['carb',6],['card',4],['carg',5],['carp',6],['carr',5],['cart',4],['case',4],['cash',4],
['casi',6],['cast',6],['casu',6],['cata',7],['catc',5],['cate',8],['catt',6],['caug',6],
['caus',5],['caut',7],['cave',4],['ceil',7],['cele',6],['ceme',6],['cens',6],['cent',7],
['cere',6],['cert',7],['chai',5],['chal',5],['cham',8],['chan',6],['chao',5],['chap',7],
['char',6],['chas',5],['chat',4],['chea',5],['chec',5],['chee',6],['chef',4],['cher',6],
['ches',5],['chic',7],['chie',5],['chil',5],['chim',7],['choi',6],['choo',6],['chro',7],
['chuc',7],['chun',5],['chur',5],['ciga',5],['cinn',8],['circ',6],['citi',7],['city',4],
['civi',5],['clai',5],['clap',4],['clar',7],['claw',4],['clay',4],['clea',5],['cler',5],
['clev',6],['clic',5],['clie',6],['clif',5],['clim',5],['clin',6],['clip',4],['cloc',5],
['clog',4],['clos',5],['clot',5],['clou',5],['clow',5],['club',4],['clum',5],['clus',7],
['clut',6],['coac',5],['coas',5],['coco',7],['code',4],['coff',6],['coil',4],['coin',4],
['coll',7],['colo',5],['colu',6],['comb',7],['come',4],['comf',7],['comi',5],['comm',6],
['comp',7],['conc',7],['cond',7],['conf',7],['cong',8],['conn',7],['cons',8],['cont',7],
['conv',8],['cook',4],['cool',4],['copp',6],['copy',4],['cora',5],['core',4],['corn',4],
['corr',7],['cost',4],['cott',6],['couc',5],['coun',7],['coup',6],['cour',6],['cous',6],
['cove',5],['coyo',6],['crac',5],['crad',6],['craf',5],['cram',4],['cran',5],['cras',5],
['crat',6],['craw',5],['craz',5],['crea',5],['cred',6],['cree',5],['crew',4],['cric',7],
['crim',5],['cris',5],['crit',6],['crop',4],['cros',5],['crou',6],['crow',5],['cruc',7],
['crue',5],['crui',6],['crum',7],['crun',6],['crus',5],['crys',7],['cube',4],['cult',7],
['cupb',8],['curi',7],['curr',7],['curt',7],['curv',5],['cush',7],['cust',6],['cute',4],
['cycl',5],['dad',3],['dama',6],['damp',4],['danc',5],['dang',6],['dari',6],['dash',4],
['daug',8],['dawn',4],['day',3],['deal',4],['deba',6],['debr',6],['deca',6],['dece',8],
['deci',6],['decl',7],['deco',8],['decr',8],['deer',4],['defe',7],['defi',6],['defy',4],
['degr',6],['dela',5],['deli',7],['dema',6],['demi',6],['deni',6],['dent',7],['deny',4],
['depa',6],['depe',6],['depo',7],['dept',5],['depu',6],['deri',6],['desc',8],['dese',6],
['desi',6],['desk',4],['desp',7],['dest',7],['deta',6],['dete',6],['deve',7],['devi',6],
['devo',6],['diag',7],['dial',4],['diam',7],['diar',5],['dice',4],['dies',6],['diet',4],
['diff',6],['digi',7],['dign',7],['dile',7],['dinn',6],['dino',8],['dire',6],['dirt',4],
['disa',8],['disc',8],['dise',7],['dish',4],['dism',7],['diso',8],['disp',7],['dist',8],
['dive',6],['divi',6],['divo',7],['dizz',5],['doct',6],['docu',8],['dog',3],['doll',4],
['dolp',7],['doma',6],['dona',6],['donk',6],['dono',5],['door',4],['dose',4],['doub',6],
['dove',4],['draf',5],['drag',6],['dram',5],['dras',7],['draw',4],['drea',5],['dres',5],
['drif',5],['dril',5],['drin',5],['drip',4],['driv',5],['drop',4],['drum',4],['dry',3],
['duck',4],['dumb',4],['dune',4],['duri',6],['dust',4],['dutc',5],['duty',4],['dwar',5],
['dyna',7],['eage',5],['eagl',5],['earl',5],['earn',4],['eart',5],['easi',6],['east',4],
['easy',4],['echo',4],['ecol',7],['econ',7],['edge',4],['edit',4],['educ',7],['effo',6],
['egg',3],['eigh',5],['eith',6],['elbo',5],['elde',5],['elec',8],['eleg',7],['elem',7],
['elep',8],['elev',8],['elit',5],['else',4],['emba',6],['embo',6],['embr',7],['emer',6],
['emot',7],['empl',6],['empo',7],['empt',5],['enab',6],['enac',5],['endl',7],['endo',7],
['enem',5],['ener',6],['enfo',7],['enga',6],['engi',6],['enha',7],['enjo',5],['enli',6],
['enou',6],['enri',6],['enro',6],['ensu',6],['ente',5],['enti',6],['entr',5],['enve',8],
['epis',7],['equa',5],['equi',5],['eras',5],['erod',5],['eros',7],['erro',5],['erup',5],
['esca',6],['essa',5],['esse',7],['esta',6],['eter',7],['ethi',6],['evid',8],['evil',4],
['evok',5],['evol',6],['exac',5],['exam',7],['exce',6],['exch',8],['exci',6],['excl',7],
['excu',6],['exec',7],['exer',8],['exha',7],['exhi',7],['exil',5],['exis',5],['exit',4],
['exot',6],['expa',6],['expe',6],['expi',6],['expl',7],['expo',6],['expr',7],['exte',6],
['extr',5],['eyeb',7],['fabr',6],['face',4],['facu',7],['fade',4],['fain',5],['fait',5],
['fall',4],['fals',5],['fame',4],['fami',6],['famo',6],['fanc',5],['fant',7],['farm',4],
['fash',7],['fata',5],['fath',6],['fati',7],['faul',5],['favo',8],['feat',7],['febr',8],
['fede',7],['feed',4],['feel',4],['fema',6],['fenc',5],['fest',8],['fetc',5],['feve',5],
['few',3],['fibe',5],['fict',7],['fiel',5],['figu',6],['file',4],['film',4],['filt',6],
['fina',5],['find',4],['fine',4],['fing',6],['fini',6],['fire',4],['firm',4],['firs',5],
['fisc',6],['fish',4],['fitn',7],['fix',3],['flag',4],['flam',5],['flas',5],['flat',4],
['flav',6],['flee',4],['flig',6],['flip',4],['floa',5],['floc',5],['floo',5],['flow',6],
['flui',5],['flus',5],['fly',3],['foam',4],['focu',5],['fog',3],['foil',4],['fold',4],
['foll',6],['food',4],['foot',4],['forc',5],['fore',6],['forg',6],['fork',4],['fort',7],
['foru',5],['forw',7],['foss',6],['fost',6],['foun',5],['fox',3],['frag',7],['fram',5],
['freq',8],['fres',5],['frie',6],['frin',6],['frog',4],['fron',5],['fros',5],['frow',5],
['froz',6],['frui',5],['fuel',4],['funn',5],['furn',7],['fury',4],['futu',6],['gadg',6],
['gain',4],['gala',6],['gall',7],['game',4],['gap',3],['gara',6],['garb',7],['gard',6],
['garl',6],['garm',7],['gasp',4],['gate',4],['gath',6],['gaug',5],['gaze',4],['gene',7],
['geni',6],['genr',5],['gent',6],['genu',7],['gest',7],['ghos',5],['gian',5],['gift',4],
['gigg',6],['ging',6],['gira',7],['girl',4],['give',4],['glad',4],['glan',6],['glar',5],
['glas',5],['glid',5],['glim',7],['glob',5],['gloo',5],['glor',5],['glov',5],['glow',4],
['glue',4],['goat',4],['godd',7],['gold',4],['good',4],['goos',5],['gori',7],['gosp',6],
['goss',6],['gove',6],['gown',4],['grab',4],['grac',5],['grai',5],['gran',5],['grap',5],
['gras',5],['grav',7],['grea',5],['gree',5],['grid',4],['grie',5],['grit',4],['groc',7],
['grou',5],['grow',4],['grun',5],['guar',5],['gues',5],['guid',5],['guil',5],['guit',6],
['gun',3],['gym',3],['habi',5],['hair',4],['half',4],['hamm',6],['hams',7],['hand',4],
['happ',5],['harb',6],['hard',4],['hars',5],['harv',7],['hat',3],['have',4],['hawk',4],
['haza',6],['head',4],['heal',6],['hear',5],['heav',5],['hedg',8],['heig',6],['hell',5],
['helm',6],['help',4],['hen',3],['hero',4],['hidd',6],['high',4],['hill',4],['hint',4],
['hip',3],['hire',4],['hist',7],['hobb',5],['hock',6],['hold',4],['hole',4],['holi',7],
['holl',6],['home',4],['hone',5],['hood',4],['hope',4],['horn',4],['horr',6],['hors',5],
['hosp',8],['host',4],['hote',5],['hour',4],['hove',5],['hub',3],['huge',4],['huma',5],
['humb',6],['humo',5],['hund',7],['hung',6],['hunt',4],['hurd',6],['hurr',5],['hurt',4],
['husb',7],['hybr',6],['ice',3],['icon',4],['idea',4],['iden',8],['idle',4],['igno',6],
['ille',7],['illn',7],['imag',5],['imit',7],['imme',7],['immu',6],['impa',6],['impo',6],
['impr',7],['impu',7],['inch',4],['incl',7],['inco',6],['incr',8],['inde',5],['indi',8],
['indo',6],['indu',8],['infa',6],['infl',7],['info',6],['inha',6],['inhe',7],['init',7],
['inje',6],['inju',6],['inma',6],['inne',5],['inno',8],['inpu',5],['inqu',7],['insa',6],
['inse',6],['insi',6],['insp',7],['inst',7],['inta',6],['inte',8],['into',4],['inve',6],
['invi',6],['invo',7],['iron',4],['isla',6],['isol',7],['issu',5],['item',4],['ivor',5],
['jack',6],['jagu',6],['jar',3],['jazz',4],['jeal',7],['jean',5],['jell',5],['jewe',5],
['job',3],['join',4],['joke',4],['jour',7],['joy',3],['judg',5],['juic',5],['jump',4],
['jung',6],['juni',6],['junk',4],['just',4],['kang',8],['keen',4],['keep',4],['ketc',7],
['key',3],['kick',4],['kidn',6],['kind',4],['king',7],['kiss',4],['kitc',7],['kite',4],
['kitt',6],['kiwi',4],['knee',4],['knif',5],['knoc',5],['know',4],['labe',5],['labo',5],
['ladd',6],['lady',4],['lake',4],['lamp',4],['lang',8],['lapt',6],['larg',5],['late',5],
['lati',5],['laug',5],['laun',7],['lava',4],['lawn',4],['laws',7],['laye',5],['lazy',4],
['lead',6],['leaf',4],['lear',5],['leav',5],['lect',7],['left',4],['lega',5],['lege',6],
['leis',7],['lemo',5],['lend',4],['leng',6],['lens',4],['leop',7],['less',6],['lett',6],
['leve',5],['liar',4],['libe',7],['libr',7],['lice',7],['life',4],['lift',4],['ligh',5],
['like',4],['limb',4],['limi',5],['link',4],['lion',4],['liqu',6],['list',4],['litt',6],
['live',4],['liza',6],['load',4],['loan',4],['lobs',7],['loca',5],['lock',4],['logi',5],
['lone',6],['long',4],['loop',4],['lott',7],['loud',4],['loun',6],['love',4],['loya',5],
['luck',5],['lugg',7],['lumb',6],['luna',5],['lunc',5],['luxu',6],['lyri',6],['mach',7],
['mad',3],['magi',5],['magn',6],['maid',4],['mail',4],['main',4],['majo',5],['make',4],
['mamm',6],['mana',6],['mand',7],['mang',5],['mans',7],['manu',6],['mapl',5],['marb',6],
['marc',5],['marg',6],['mari',6],['mark',6],['marr',8],['mask',4],['mass',4],['mast',6],
['matc',5],['mate',8],['math',4],['matr',6],['matt',6],['maxi',7],['maze',4],['mead',6],
['mean',4],['meas',7],['meat',4],['mech',8],['meda',5],['medi',5],['melo',6],['melt',4],
['memb',6],['memo',6],['ment',7],['menu',4],['merc',5],['merg',5],['meri',5],['merr',5],
['mesh',4],['mess',7],['meta',5],['meth',6],['midd',6],['midn',8],['milk',4],['mill',7],
['mimi',5],['mind',4],['mini',7],['mino',5],['minu',6],['mira',7],['mirr',6],['mise',6],
['miss',4],['mist',7],['mixe',5],['mixt',7],['mobi',6],['mode',5],['modi',6],['mome',6],
['moni',7],['monk',6],['mons',7],['mont',5],['moon',4],['mora',5],['more',4],['morn',7],
['mosq',8],['moth',6],['moti',6],['moto',5],['moun',8],['mous',5],['move',4],['movi',5],
['much',4],['muff',6],['mule',4],['mult',8],['musc',6],['muse',6],['mush',8],['musi',5],
['must',4],['mutu',6],['myse',6],['myst',7],['myth',4],['naiv',5],['name',4],['napk',6],
['narr',6],['nast',5],['nati',6],['natu',6],['near',4],['neck',4],['need',4],['nega',8],
['negl',7],['neit',7],['neph',6],['nerv',5],['nest',4],['netw',7],['neut',7],['neve',5],
['news',4],['next',4],['nice',4],['nigh',5],['nobl',5],['nois',5],['nomi',7],['nood',6],
['norm',6],['nort',5],['nose',4],['nota',7],['note',4],['noth',7],['noti',6],['nove',5],
['now',3],['nucl',7],['numb',6],['nurs',5],['nut',3],['oak',3],['obey',4],['obje',6],
['obli',6],['obsc',7],['obse',7],['obta',6],['obvi',7],['occu',5],['ocea',5],['octo',7],
['odor',4],['offe',5],['offi',6],['ofte',5],['oil',3],['okay',4],['old',3],['oliv',5],
['olym',7],['omit',4],['once',4],['one',3],['onio',5],['onli',6],['only',4],['open',4],
['oper',5],['opin',7],['oppo',6],['opti',6],['oran',6],['orbi',5],['orch',7],['orde',5],
['ordi',8],['orga',5],['orie',6],['orig',8],['orph',6],['ostr',7],['othe',5],['outd',7],
['oute',5],['outp',6],['outs',7],['oval',4],['oven',4],['over',4],['owne',5],['oxyg',6],
['oyst',6],['ozon',5],['pact',4],['padd',6],['page',4],['pair',4],['pala',6],['palm',4],
['pand',5],['pane',5],['pani',5],['pant',7],['pape',5],['para',6],['pare',6],['park',4],
['parr',6],['part',5],['pass',4],['patc',5],['path',4],['pati',7],['patr',6],['patt',7],
['paus',5],['pave',4],['paym',7],['peac',5],['pean',6],['pear',4],['peas',7],['peli',7],
['pena',7],['penc',6],['peop',6],['pepp',6],['perf',7],['perm',6],['pers',6],['pet',3],
['phon',5],['phot',5],['phra',6],['phys',8],['pian',5],['picn',6],['pict',7],['piec',5],
['pige',6],['pill',4],['pilo',5],['pink',4],['pion',7],['pipe',4],['pist',6],['pitc',5],
['pizz',5],['plac',5],['plan',6],['plas',7],['plat',5],['play',4],['plea',6],['pled',6],
['pluc',5],['plug',4],['plun',6],['poem',4],['poet',4],['poin',5],['pola',5],['pole',4],
['poli',6],['pond',4],['pony',4],['pool',4],['popu',7],['port',7],['posi',8],['poss',8],
['post',4],['pota',6],['pott',7],['pove',7],['powd',6],['powe',5],['prac',8],['prai',6],
['pred',7],['pref',6],['prep',7],['pres',7],['pret',6],['prev',7],['pric',5],['prid',5],
['prim',7],['prin',5],['prio',8],['pris',6],['priv',7],['priz',5],['prob',7],['proc',7],
['prod',7],['prof',6],['prog',7],['proj',7],['prom',7],['proo',5],['prop',8],['pros',7],
['prot',7],['prou',5],['prov',7],['publ',6],['pudd',7],['pull',4],['pulp',4],['puls',5],
['pump',7],['punc',5],['pupi',5],['pupp',5],['purc',8],['puri',6],['purp',7],['purs',5],
['push',4],['put',3],['puzz',6],['pyra',7],['qual',7],['quan',7],['quar',7],['ques',8],
['quic',5],['quit',4],['quiz',4],['quot',5],['rabb',6],['racc',7],['race',4],['rack',4],
['rada',5],['radi',5],['rail',4],['rain',4],['rais',5],['rall',5],['ramp',4],['ranc',5],
['rand',6],['rang',5],['rapi',5],['rare',4],['rate',4],['rath',6],['rave',5],['raw',3],
['razo',5],['read',5],['real',4],['reas',6],['rebe',5],['rebu',7],['reca',6],['rece',7],
['reci',6],['reco',6],['recy',7],['redu',6],['refl',7],['refo',6],['refu',6],['regi',6],
['regr',6],['regu',7],['reje',6],['rela',5],['rele',7],['reli',6],['rely',4],['rema',6],
['reme',8],['remi',6],['remo',6],['rend',6],['rene',5],['rent',4],['reop',6],['repa',6],
['repe',6],['repl',7],['repo',6],['requ',7],['resc',6],['rese',8],['resi',6],['reso',8],
['resp',8],['resu',6],['reti',6],['retr',7],['retu',6],['reun',7],['reve',6],['revi',6],
['rewa',6],['rhyt',6],['ribb',6],['rice',4],['rich',4],['ride',4],['ridg',5],['rifl',5],
['righ',5],['rigi',5],['ring',4],['riot',4],['ripp',6],['risk',4],['ritu',6],['riva',5],
['rive',5],['road',4],['roas',5],['robo',5],['robu',6],['rock',6],['roma',7],['roof',4],
['rook',6],['room',4],['rose',4],['rota',6],['roug',5],['roun',5],['rout',5],['roya',5],
['rubb',6],['rude',4],['rug',3],['rule',4],['runw',6],['rura',5],['sadd',6],['sadn',7],
['safe',4],['sail',4],['sala',5],['salm',6],['salo',5],['salt',4],['salu',6],['same',4],
['samp',6],['sand',4],['sati',7],['sato',7],['sauc',5],['saus',7],['save',4],['say',3],
['scal',5],['scan',4],['scar',5],['scat',7],['scen',5],['sche',6],['scho',6],['scie',7],
['scis',8],['scor',8],['scou',5],['scra',5],['scre',6],['scri',6],['scru',5],['sear',6],
['seas',6],['seat',4],['seco',6],['secr',6],['sect',7],['secu',8],['seed',4],['seek',4],
['segm',7],['sele',6],['sell',4],['semi',7],['seni',6],['sens',5],['sent',8],['seri',6],
['serv',7],['sess',7],['sett',6],['setu',5],['seve',5],['shad',6],['shaf',5],['shal',7],
['shar',5],['shed',4],['shel',5],['sher',7],['shie',6],['shif',5],['shin',5],['ship',4],
['shiv',6],['shoc',5],['shoe',4],['shoo',5],['shop',4],['shor',5],['shou',8],['shov',5],
['shri',6],['shru',5],['shuf',7],['shy',3],['sibl',7],['sick',4],['side',4],['sieg',5],
['sigh',5],['sign',4],['sile',6],['silk',4],['sill',5],['silv',6],['simi',7],['simp',6],
['sinc',5],['sing',4],['sire',5],['sist',6],['situ',7],['six',3],['size',4],['skat',5],
['sket',6],['skil',5],['skin',4],['skir',5],['skul',5],['slab',4],['slam',4],['slee',5],
['slen',7],['slic',5],['slid',5],['slig',6],['slim',4],['slog',6],['slot',4],['slow',4],
['slus',5],['smal',5],['smar',5],['smil',5],['smok',5],['smoo',6],['snac',5],['snak',5],
['snap',4],['snif',5],['snow',4],['soap',4],['socc',6],['soci',6],['sock',4],['soda',4],
['soft',4],['sola',5],['sold',7],['soli',5],['solu',8],['solv',5],['some',7],['song',4],
['soon',4],['sorr',5],['sort',4],['soul',4],['soun',5],['soup',4],['sour',6],['sout',5],
['spac',5],['spar',5],['spat',7],['spaw',5],['spea',5],['spec',7],['spee',5],['spel',5],
['spen',5],['sphe',6],['spic',5],['spid',6],['spik',5],['spin',4],['spir',6],['spli',5],
['spoi',5],['spon',7],['spoo',5],['spor',5],['spot',4],['spra',5],['spre',6],['spri',6],
['spy',3],['squa',6],['sque',7],['squi',8],['stab',6],['stad',7],['staf',5],['stag',5],
['stai',6],['stam',5],['stan',5],['star',5],['stat',5],['stay',4],['stea',5],['stee',5],
['stem',4],['step',4],['ster',6],['stic',5],['stil',5],['stin',5],['stoc',5],['stom',7],
['ston',5],['stoo',5],['stor',5],['stov',5],['stra',8],['stre',6],['stri',6],['stro',6],
['stru',8],['stud',7],['stuf',5],['stum',7],['styl',5],['subj',7],['subm',6],['subw',6],
['succ',7],['such',4],['sudd',6],['suff',6],['suga',5],['sugg',7],['suit',4],['summ',6],
['sunn',5],['suns',6],['supe',5],['supp',6],['supr',7],['sure',4],['surf',7],['surg',5],
['surp',8],['surr',8],['surv',6],['susp',7],['sust',7],['swal',7],['swam',5],['swap',4],
['swar',5],['swea',5],['swee',5],['swif',5],['swim',4],['swin',5],['swit',6],['swor',5],
['symb',6],['symp',7],['syru',5],['syst',6],['tabl',5],['tack',6],['tag',3],['tail',4],
['tale',6],['talk',4],['tank',4],['tape',4],['targ',6],['task',4],['tast',5],['tatt',6],
['taxi',4],['teac',5],['team',4],['tell',4],['tena',6],['tenn',6],['tent',4],['term',4],
['test',4],['text',4],['than',5],['that',4],['them',5],['then',4],['theo',6],['ther',5],
['they',4],['thin',5],['this',4],['thou',7],['thre',5],['thri',6],['thro',5],['thum',5],
['thun',7],['tick',6],['tide',4],['tige',5],['tilt',4],['timb',6],['time',4],['tiny',4],
['tip',3],['tire',5],['tiss',6],['titl',5],['toas',5],['toba',7],['toda',5],['todd',7],
['toe',3],['toge',8],['toil',6],['toke',5],['toma',6],['tomo',8],['tone',4],['tong',6],
['toni',7],['tool',4],['toot',5],['topi',5],['topp',6],['torc',5],['torn',7],['tort',8],
['toss',4],['tota',5],['tour',7],['towa',6],['towe',5],['town',4],['toy',3],['trac',5],
['trad',5],['traf',7],['trag',6],['trai',5],['tran',8],['trap',4],['tras',5],['trav',6],
['tray',4],['trea',5],['tree',4],['tren',5],['tria',5],['trib',5],['tric',5],['trig',7],
['trim',4],['trip',4],['trop',6],['trou',7],['truc',5],['true',4],['trul',5],['trum',7],
['trus',5],['trut',5],['try',3],['tube',4],['tuit',7],['tumb',6],['tuna',4],['tunn',6],
['turk',6],['turn',4],['turt',6],['twel',6],['twen',6],['twic',5],['twin',4],['twis',5],
['two',3],['type',4],['typi',7],['ugly',4],['umbr',8],['unab',6],['unaw',7],['uncl',5],
['unco',7],['unde',5],['undo',4],['unfa',6],['unfo',6],['unha',7],['unif',7],['uniq',6],
['unit',4],['univ',8],['unkn',7],['unlo',6],['unti',5],['unus',7],['unve',6],['upda',6],
['upgr',7],['upho',6],['upon',4],['uppe',5],['upse',5],['urba',5],['urge',4],['usag',5],
['used',4],['usef',6],['usel',7],['usua',5],['util',7],['vaca',6],['vacu',6],['vagu',5],
['vali',5],['vall',6],['valv',5],['vani',6],['vapo',5],['vari',7],['vast',4],['vaul',5],
['vehi',7],['velv',6],['vend',6],['vent',7],['venu',5],['verb',4],['veri',6],['vers',7],
['very',4],['vess',6],['vete',7],['viab',6],['vibr',7],['vici',7],['vict',7],['vide',5],
['view',4],['vill',7],['vint',7],['viol',6],['virt',7],['viru',5],['visa',4],['visi',5],
['visu',6],['vita',5],['vivi',5],['voca',5],['voic',5],['void',4],['volc',7],['volu',6],
['vote',4],['voya',6],['wage',4],['wago',5],['wait',4],['walk',4],['wall',4],['waln',6],
['want',4],['warf',7],['warm',4],['warr',7],['wash',4],['wasp',4],['wast',5],['wate',5],
['wave',4],['way',3],['weal',6],['weap',6],['wear',4],['weas',6],['weat',7],['web',3],
['wedd',7],['week',7],['weir',5],['welc',7],['west',4],['wet',3],['whal',5],['what',4],
['whea',5],['whee',5],['when',4],['wher',5],['whip',4],['whis',7],['wide',4],['widt',5],
['wife',4],['wild',4],['will',4],['wind',6],['wine',4],['wing',4],['wink',4],['winn',6],
['wint',6],['wire',4],['wisd',6],['wise',4],['wish',4],['witn',7],['wolf',4],['woma',5],
['wond',6],['wood',4],['wool',4],['word',4],['work',4],['worl',5],['worr',5],['wort',5],
['wrap',4],['wrec',5],['wres',7],['wris',5],['writ',5],['wron',5],['yard',4],['year',4],
['yell',6],['youn',5],['yout',5],['zebr',5],['zero',4],['zone',4],['zoo',3]
])

/**
 * Find the length of a BIP39 word starting at position pos in the string.
 * Returns 0 if no word is found.
 */
function wordLenAt(s: string, pos: number): number {
  // Try 4-char prefix (covers 4+ letter words)
  if (pos + 4 <= s.length) {
    const p4 = s.substring(pos, pos + 4)
    const len = W.get(p4)
    if (len !== undefined) return len
  }
  // Try 3-char prefix (for 3-letter words)
  if (pos + 3 <= s.length) {
    const p3 = s.substring(pos, pos + 3)
    const len = W.get(p3)
    if (len !== undefined && len === 3) return 3
  }
  return 0
}

/**
 * Format a DNN ID for display with proper capitalization.
 *
 * Input:  "nabandonzooa" (all lowercase)
 * Output: "nAbandonZooA" (n + TitleWord1 + TitleWord2 + UPPER_SUFFIX)
 *
 * If the ID doesn't match the encoded format (n + word + word + suffix),
 * it is returned unchanged.
 */
export function formatDnnId(dnnId: string): string {
  if (!dnnId || dnnId.length < 2) return dnnId
  const lower = dnnId.toLowerCase()

  // Only format encoded IDs starting with 'n' followed by letters
  if (lower[0] !== 'n' || !/^n[a-z]/.test(lower)) return dnnId

  // Find word 1 starting at position 1
  const w1Len = wordLenAt(lower, 1)
  if (w1Len === 0) return dnnId

  // Find word 2 starting after word 1
  const w2Start = 1 + w1Len
  if (w2Start >= lower.length) return dnnId
  const w2Len = wordLenAt(lower, w2Start)
  if (w2Len === 0) return dnnId

  // Suffix starts after word 2
  const suffixStart = w2Start + w2Len
  if (suffixStart > lower.length) return dnnId

  // Build formatted string
  const prefix = 'n'
  const word1 = lower[1].toUpperCase() + lower.substring(2, 1 + w1Len)
  const word2 = lower[w2Start].toUpperCase() + lower.substring(w2Start + 1, w2Start + w2Len)
  const suffix = lower.substring(suffixStart).toUpperCase()

  return prefix + word1 + word2 + suffix
}
