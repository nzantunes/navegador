// ============================================================================
// PAPALÉGUAS I18N POR IP - TRADUÇÃO AUTOMÁTICA DE TODA A APLICAÇÃO PELO IP
// ============================================================================
(function () {
  'use strict';

  const COUNTRY_TO_LANG = {
    BR: 'pt', PT: 'pt', AO: 'pt', MZ: 'pt', CV: 'pt',
    US: 'en', GB: 'en', CA: 'en', AU: 'en', NZ: 'en', IE: 'en', IN: 'en', ZA: 'en', NG: 'en',
    ES: 'es', AR: 'es', MX: 'es', CO: 'es', CL: 'es', PE: 'es', UY: 'es', VE: 'es', EC: 'es', BO: 'es', PY: 'es',
    FR: 'fr', BE: 'fr',
    DE: 'de', AT: 'de', CH: 'de',
    IT: 'it'
  };

  const COUNTRY_TO_HL = {
    BR: 'pt-BR', PT: 'pt-PT', US: 'en-US', GB: 'en-GB', CA: 'en-CA', AU: 'en-AU',
    ES: 'es-ES', AR: 'es-AR', MX: 'es-MX', FR: 'fr-FR', DE: 'de-DE', IT: 'it-IT'
  };

  const DICT = {
    pt: {
      countryNames: {
        BR: 'Brasil', US: 'Estados Unidos', GB: 'Reino Unido', AR: 'Argentina',
        MX: 'México', PT: 'Portugal', ES: 'Espanha', FR: 'França', DE: 'Alemanha',
        IT: 'Itália', JP: 'Japão', KR: 'Coreia do Sul', CN: 'China', RU: 'Rússia',
        CA: 'Canadá', AU: 'Austrália', IN: 'Índia'
      },
      autoCountryLabel: '🌐 Automático',
      downloadApp: 'Baixar App',
      chips: {
        'noticias': '📰 Notícias',
        'curtidos': '👍 Para Você',
        'musicas': '🎵 Músicas',
        'esportes': '⚽ Esportes',
        'financeiro': '💰 Financeiro',
        'criptomoedas': '🪙 Criptomoedas',
        'podcasts': '🎙️ Podcasts',
        'games': '🎮 Games',
        'filmes trailers': '🎬 Filmes & Trailers',
        'tecnologia': '🚀 Tecnologia',
        'ao vivo': '🔴 Ao Vivo',
        'humor': '😂 Humor',
        'em alta': '🔥 Tudo / Em Alta'
      },
      baixatubeSubtitle: 'Assista sem propaganda e baixe nos formatos MP4 e MP3',
      feedHeadingDefault: 'Notícias das últimas horas',
      newVideosBtn: 'Novos Vídeos',
      timeFilter: {
        none: 'Mais Relevantes',
        hour: 'Últimas Horas',
        day: 'Hoje (24h)',
        week: 'Esta Semana',
        month: 'Este Mês'
      },
      searchBaixatubePlaceholder: 'Buscar no BaixaTube...',
      likeBtn: '👍 Curtir',
      likedBtn: '👍 Curtido',
      dislikeBtn: '👎 Descurtir',
      dislikedBtn: '👎 Descurtido',
      optionBtn: '⚙️ Opção',
      dlMp4Btn: '🎬 Download MP4',
      dlMp3Btn: '🎵 Download MP3',
      castBtn: '📺 Transmitir',
      trendsTitlePrefix: 'Top 10 Em Alta no Google Trends',
      trendsSubtitle: 'Assuntos mais pesquisados no Google hoje junto com as notícias',
      loadingMoreVideos: '⚡ Carregando mais vídeos do YouTube...',
      nativeLoadingText: 'Iniciando reprodução direta sem bloqueio...',
      backToTop: '↑ Topo',
      // Browser Shell (index.html)
      privateMode: 'Privado',
      urlPlaceholder: 'Pesquise com privacidade ou acesse um site...',
      torConnected: 'Tor: Conectado',
      adsAllowed: 'Anúncios Permitidos',
      adsBlocked: 'Anúncios Bloqueados',
      moviesBtn: 'Filmes',
      circuitBtn: 'Circuito',
      addBookmarkBtn: 'Adicionar',
      openTabs: 'Abas abertas',
      newTab: 'Nova aba',
      saveAllBookmarks: 'Salvar todas como favoritas',
      voiceListening: 'Estou te ouvindo...',
      voiceSub: 'Fale seu comando. Detectarei automaticamente quando você terminar.',
      voiceFinish: 'Concluir e Enviar',
      voiceCancel: 'Cancelar',
      // Music (musica.html)
      musicSearchPlaceholder: 'O que você quer ouvir no Papaléguas Music?',
      musicChips: {
        ai: '✨ IA Recomenda',
        playlist: '📁 Playlists ▾',
        all: 'Tudo',
        track: 'Músicas',
        artist: 'Artistas',
        album: 'Álbuns',
        podcast: 'Podcasts'
      },
      genresTitle: 'Gêneros & Estilos Musicais',
      genresBadge: '🎵 Carrossel de Estilos',
      equalizer: 'Equalizador',
      // Cinema (/filmes)
      cinemaTitle: 'Filmes Online',
      cinemaSearchPlaceholder: 'Buscar filmes dublados completos...',
      cinemaSearchBtn: 'Buscar',
      cinemaRefreshBtn: '🎲 Sortear Novos Filmes',
      cinemaRefreshShort: '🎲 Sortear',
      cinemaSectionTitle: '🍿 Filmes Completos Dublados',
      cinemaCountWord: 'filmes',
      cinemaLoaderText: '🍿 Buscando mais filmes dublados completos...',
      cinemaCats: {
        todos: '🎬 Todos',
        acao: '💥 Ação',
        comedia: '😂 Comédia',
        terror: '👻 Terror',
        suspense: '🔍 Suspense',
        ficcao: '🚀 Ficção',
        aventura: '🏹 Aventura',
        animacao: '🦁 Animação',
        luta: '🥋 Luta & Artes Marciais'
      },
      cinemaMaximize: '⛶ Maximizar',
      cinemaMinimize: '🗕 Minimizar',
      cinemaMiniPlayer: '🗕 Mini Player',
      cinemaWatchDirect: '▶ Assistir Direto',
      cinemaDlMp4: '🎬 Baixar MP4',
      cinemaDlMp3: '🎵 Áudio MP3',
      cinemaCast: '📺 Transmitir',
      cinemaClose: 'Fechar',
      watchNow: '▶ Assistir Agora'
    },
    en: {
      countryNames: {
        BR: 'Brazil', US: 'United States', GB: 'United Kingdom', AR: 'Argentina',
        MX: 'Mexico', PT: 'Portugal', ES: 'Spain', FR: 'France', DE: 'Germany',
        IT: 'Italy', JP: 'Japan', KR: 'South Korea', CN: 'China', RU: 'Russia',
        CA: 'Canada', AU: 'Australia', IN: 'India'
      },
      autoCountryLabel: '🌐 Auto',
      downloadApp: 'Get App',
      chips: {
        'noticias': '📰 News',
        'curtidos': '👍 For You',
        'musicas': '🎵 Music',
        'esportes': '⚽ Sports',
        'financeiro': '💰 Finance',
        'criptomoedas': '🪙 Crypto',
        'podcasts': '🎙️ Podcasts',
        'games': '🎮 Gaming',
        'filmes trailers': '🎬 Movies & Trailers',
        'tecnologia': '🚀 Tech',
        'ao vivo': '🔴 Live',
        'humor': '😂 Comedy',
        'em alta': '🔥 All / Trending'
      },
      baixatubeSubtitle: 'Watch ad-free and download in MP4 & MP3 formats',
      feedHeadingDefault: 'Breaking News & Latest Videos',
      newVideosBtn: 'New Videos',
      timeFilter: {
        none: 'Most Relevant',
        hour: 'Last Hours',
        day: 'Today (24h)',
        week: 'This Week',
        month: 'This Month'
      },
      searchBaixatubePlaceholder: 'Search on BaixaTube...',
      likeBtn: '👍 Like',
      likedBtn: '👍 Liked',
      dislikeBtn: '👎 Dislike',
      dislikedBtn: '👎 Disliked',
      optionBtn: '⚙️ Options',
      dlMp4Btn: '🎬 Download MP4',
      dlMp3Btn: '🎵 Download MP3',
      castBtn: '📺 Cast to TV',
      trendsTitlePrefix: 'Top 10 Trending on Google Trends',
      trendsSubtitle: 'Most searched topics on Google today alongside the news',
      loadingMoreVideos: '⚡ Loading more YouTube videos...',
      nativeLoadingText: 'Starting direct unblocked playback...',
      backToTop: '↑ Top',
      privateMode: 'Private',
      urlPlaceholder: 'Search privately or enter a website...',
      torConnected: 'Tor: Connected',
      adsAllowed: 'Ads Allowed',
      adsBlocked: 'Ads Blocked',
      moviesBtn: 'Movies',
      circuitBtn: 'Circuit',
      addBookmarkBtn: 'Add',
      openTabs: 'Open tabs',
      newTab: 'New tab',
      saveAllBookmarks: 'Save all as bookmarks',
      voiceListening: 'Listening to you...',
      voiceSub: 'Speak your command. I will detect automatically when you finish.',
      voiceFinish: 'Finish & Send',
      voiceCancel: 'Cancel',
      musicSearchPlaceholder: 'What do you want to listen to on Papaléguas Music?',
      musicChips: {
        ai: '✨ AI Recommends',
        playlist: '📁 Playlists ▾',
        all: 'All',
        track: 'Songs',
        artist: 'Artists',
        album: 'Albums',
        podcast: 'Podcasts'
      },
      genresTitle: 'Musical Genres & Styles',
      genresBadge: '🎵 Style Carousel',
      equalizer: 'Equalizer',
      cinemaTitle: 'Movies Online',
      cinemaSearchPlaceholder: 'Search full movies in HD...',
      cinemaSearchBtn: 'Search',
      cinemaRefreshBtn: '🎲 Shuffle New Movies',
      cinemaRefreshShort: '🎲 Shuffle',
      cinemaSectionTitle: '🍿 Full Movies Online',
      cinemaCountWord: 'movies',
      cinemaLoaderText: '🍿 Loading more full movies...',
      cinemaCats: {
        todos: '🎬 All',
        acao: '💥 Action',
        comedia: '😂 Comedy',
        terror: '👻 Horror',
        suspense: '🔍 Thriller',
        ficcao: '🚀 Sci-Fi',
        aventura: '🏹 Adventure',
        animacao: '🦁 Animation',
        luta: '🥋 Martial Arts'
      },
      cinemaMaximize: '⛶ Maximize',
      cinemaMinimize: '🗕 Minimize',
      cinemaMiniPlayer: '🗕 Mini Player',
      cinemaWatchDirect: '▶ Watch Direct',
      cinemaDlMp4: '🎬 Download MP4',
      cinemaDlMp3: '🎵 Audio MP3',
      cinemaCast: '📺 Cast',
      cinemaClose: 'Close',
      watchNow: '▶ Watch Now'
    },
    es: {
      countryNames: {
        BR: 'Brasil', US: 'Estados Unidos', GB: 'Reino Unido', AR: 'Argentina',
        MX: 'México', PT: 'Portugal', ES: 'España', FR: 'Francia', DE: 'Alemania',
        IT: 'Italia', JP: 'Japón', KR: 'Corea del Sur', CN: 'China', RU: 'Rusia',
        CA: 'Canadá', AU: 'Australia', IN: 'India'
      },
      autoCountryLabel: '🌐 Automático',
      downloadApp: 'Descargar App',
      chips: {
        'noticias': '📰 Noticias',
        'curtidos': '👍 Para Ti',
        'musicas': '🎵 Música',
        'esportes': '⚽ Deportes',
        'financeiro': '💰 Finanzas',
        'criptomoedas': '🪙 Criptomonedas',
        'podcasts': '🎙️ Podcasts',
        'games': '🎮 Juegos',
        'filmes trailers': '🎬 Películas y Tráilers',
        'tecnologia': '🚀 Tecnología',
        'ao vivo': '🔴 En Vivo',
        'humor': '😂 Humor',
        'em alta': '🔥 Todo / Tendencias'
      },
      baixatubeSubtitle: 'Mira sin anuncios y descarga en formatos MP4 y MP3',
      feedHeadingDefault: 'Noticias de las últimas horas',
      newVideosBtn: 'Nuevos Videos',
      timeFilter: {
        none: 'Más Relevantes',
        hour: 'Últimas Horas',
        day: 'Hoy (24h)',
        week: 'Esta Semana',
        month: 'Este Mes'
      },
      searchBaixatubePlaceholder: 'Buscar en BaixaTube...',
      likeBtn: '👍 Me gusta',
      likedBtn: '👍 Te gusta',
      dislikeBtn: '👎 No me gusta',
      dislikedBtn: '👎 Descartado',
      optionBtn: '⚙️ Opción',
      dlMp4Btn: '🎬 Descargar MP4',
      dlMp3Btn: '🎵 Descargar MP3',
      castBtn: '📺 Transmitir',
      trendsTitlePrefix: 'Top 10 en Tendencia en Google Trends',
      trendsSubtitle: 'Temas más buscados en Google hoy junto con las noticias',
      loadingMoreVideos: '⚡ Cargando más videos de YouTube...',
      nativeLoadingText: 'Iniciando reproducción directa sin bloqueo...',
      backToTop: '↑ Arriba',
      privateMode: 'Privado',
      urlPlaceholder: 'Busca con privacidad o ingresa a un sitio...',
      torConnected: 'Tor: Conectado',
      adsAllowed: 'Anuncios Permitidos',
      adsBlocked: 'Anuncios Bloqueados',
      moviesBtn: 'Películas',
      circuitBtn: 'Circuito',
      addBookmarkBtn: 'Añadir',
      openTabs: 'Pestañas abiertas',
      newTab: 'Nueva pestaña',
      saveAllBookmarks: 'Guardar todas en favoritos',
      voiceListening: 'Te estoy escuchando...',
      voiceSub: 'Di tu comando. Detectaré automáticamente cuando termines.',
      voiceFinish: 'Finalizar y Enviar',
      voiceCancel: 'Cancelar',
      musicSearchPlaceholder: '¿Qué quieres escuchar en Papaléguas Music?',
      musicChips: {
        ai: '✨ IA Recomienda',
        playlist: '📁 Listas ▾',
        all: 'Todo',
        track: 'Canciones',
        artist: 'Artistas',
        album: 'Álbumes',
        podcast: 'Podcasts'
      },
      genresTitle: 'Géneros y Estilos Musicales',
      genresBadge: '🎵 Carrusel de Estilos',
      equalizer: 'Ecualizador',
      cinemaTitle: 'Películas Online',
      cinemaSearchPlaceholder: 'Buscar películas completas en español...',
      cinemaSearchBtn: 'Buscar',
      cinemaRefreshBtn: '🎲 Sortear Nuevas Películas',
      cinemaRefreshShort: '🎲 Sortear',
      cinemaSectionTitle: '🍿 Películas Completas en Español',
      cinemaCountWord: 'películas',
      cinemaLoaderText: '🍿 Buscando más películas completas...',
      cinemaCats: {
        todos: '🎬 Todas',
        acao: '💥 Acción',
        comedia: '😂 Comedia',
        terror: '👻 Terror',
        suspense: '🔍 Suspenso',
        ficcao: '🚀 Ciencia Ficción',
        aventura: '🏹 Aventura',
        animacao: '🦁 Animación',
        luta: '🥋 Artes Marciales'
      },
      cinemaMaximize: '⛶ Maximizar',
      cinemaMinimize: '🗕 Minimizar',
      cinemaMiniPlayer: '🗕 Mini Reproductor',
      cinemaWatchDirect: '▶ Ver Directo',
      cinemaDlMp4: '🎬 Descargar MP4',
      cinemaDlMp3: '🎵 Audio MP3',
      cinemaCast: '📺 Transmitir',
      cinemaClose: 'Cerrar',
      watchNow: '▶ Ver Ahora'
    },
    fr: {
      countryNames: {
        BR: 'Brésil', US: 'États-Unis', GB: 'Royaume-Uni', AR: 'Argentine',
        MX: 'Mexique', PT: 'Portugal', ES: 'Espagne', FR: 'France', DE: 'Allemagne',
        IT: 'Italie', JP: 'Japon', KR: 'Corée du Sud', CN: 'Chine', RU: 'Russie',
        CA: 'Canada', AU: 'Australie', IN: 'Inde'
      },
      autoCountryLabel: '🌐 Auto',
      downloadApp: 'Télécharger App',
      chips: {
        'noticias': '📰 Actualités',
        'curtidos': '👍 Pour Vous',
        'musicas': '🎵 Musique',
        'esportes': '⚽ Sports',
        'financeiro': '💰 Finance',
        'criptomoedas': '🪙 Crypto',
        'podcasts': '🎙️ Podcasts',
        'games': '🎮 Jeux',
        'filmes trailers': '🎬 Films & Bandes-annonces',
        'tecnologia': '🚀 Technologie',
        'ao vivo': '🔴 En Direct',
        'humor': '😂 Humour',
        'em alta': '🔥 Tout / Tendances'
      },
      baixatubeSubtitle: 'Regardez sans publicité et téléchargez en MP4 et MP3',
      feedHeadingDefault: 'Actualités des dernières heures',
      newVideosBtn: 'Nouvelles Vidéos',
      timeFilter: {
        none: 'Plus Pertinents',
        hour: 'Dernières Heures',
        day: "Aujourd'hui (24h)",
        week: 'Cette Semaine',
        month: 'Ce Mois-ci'
      },
      searchBaixatubePlaceholder: 'Rechercher sur BaixaTube...',
      likeBtn: "👍 J'aime",
      likedBtn: '👍 Aimé',
      dislikeBtn: "👎 Je n'aime pas",
      dislikedBtn: '👎 Masqué',
      optionBtn: '⚙️ Option',
      dlMp4Btn: '🎬 Télécharger MP4',
      dlMp3Btn: '🎵 Télécharger MP3',
      castBtn: '📺 Diffuser',
      trendsTitlePrefix: 'Top 10 des Tendances Google Trends',
      trendsSubtitle: "Sujets les plus recherchés sur Google aujourd'hui",
      loadingMoreVideos: '⚡ Chargement de plus de vidéos...',
      nativeLoadingText: 'Démarrage de la lecture directe...',
      backToTop: '↑ Haut',
      privateMode: 'Privé',
      urlPlaceholder: 'Recherchez en privé ou entrez un site...',
      torConnected: 'Tor : Connecté',
      adsAllowed: 'Pubs Autorisées',
      adsBlocked: 'Pubs Bloquées',
      moviesBtn: 'Films',
      circuitBtn: 'Circuit',
      addBookmarkBtn: 'Ajouter',
      openTabs: 'Onglets ouverts',
      newTab: 'Nouvel onglet',
      saveAllBookmarks: 'Tout enregistrer en favoris',
      voiceListening: 'Je vous écoute...',
      voiceSub: 'Parlez maintenant.',
      voiceFinish: 'Terminer et Envoyer',
      voiceCancel: 'Annuler',
      musicSearchPlaceholder: 'Que voulez-vous écouter sur Papaléguas Music ?',
      musicChips: {
        ai: '✨ IA Recommande',
        playlist: '📁 Playlists ▾',
        all: 'Tout',
        track: 'Titres',
        artist: 'Artistes',
        album: 'Albums',
        podcast: 'Podcasts'
      },
      genresTitle: 'Genres & Styles Musicaux',
      genresBadge: '🎵 Carrousel de Styles',
      equalizer: 'Égaliseur',
      cinemaTitle: 'Films en Ligne',
      cinemaSearchPlaceholder: 'Rechercher des films complets en français...',
      cinemaSearchBtn: 'Chercher',
      cinemaRefreshBtn: '🎲 Tirer de Nouveaux Films',
      cinemaRefreshShort: '🎲 Tirer',
      cinemaSectionTitle: '🍿 Films Complets en Français',
      cinemaCountWord: 'films',
      cinemaLoaderText: '🍿 Chargement de plus de films complets...',
      cinemaCats: {
        todos: '🎬 Tous',
        acao: '💥 Action',
        comedia: '😂 Comédie',
        terror: '👻 Horreur',
        suspense: '🔍 Thriller',
        ficcao: '🚀 Sci-Fi',
        aventura: '🏹 Aventure',
        animacao: '🦁 Animation',
        luta: '🥋 Arts Martiaux'
      },
      cinemaMaximize: '⛶ Agrandir',
      cinemaMinimize: '🗕 Réduire',
      cinemaMiniPlayer: '🗕 Mini Lecteur',
      cinemaWatchDirect: '▶ Regarder Direct',
      cinemaDlMp4: '🎬 Télécharger MP4',
      cinemaDlMp3: '🎵 Audio MP3',
      cinemaCast: '📺 Diffuser',
      cinemaClose: 'Fermer',
      watchNow: '▶ Regarder'
    },
    de: {
      countryNames: {
        BR: 'Brasilien', US: 'USA', GB: 'Großbritannien', AR: 'Argentinien',
        MX: 'Mexiko', PT: 'Portugal', ES: 'Spanien', FR: 'Frankreich', DE: 'Deutschland',
        IT: 'Italien', JP: 'Japan', KR: 'Südkorea', CN: 'China', RU: 'Russland',
        CA: 'Kanada', AU: 'Australien', IN: 'Indien'
      },
      autoCountryLabel: '🌐 Automatisch',
      downloadApp: 'App Laden',
      chips: {
        'noticias': '📰 Nachrichten',
        'curtidos': '👍 Für Dich',
        'musicas': '🎵 Musik',
        'esportes': '⚽ Sport',
        'financeiro': '💰 Finanzen',
        'criptomoedas': '🪙 Krypto',
        'podcasts': '🎙️ Podcasts',
        'games': '🎮 Gaming',
        'filmes trailers': '🎬 Filme & Trailer',
        'tecnologia': '🚀 Technik',
        'ao vivo': '🔴 Live',
        'humor': '😂 Comedy',
        'em alta': '🔥 Alle / Trends'
      },
      baixatubeSubtitle: 'Werbefrei ansehen und als MP4 & MP3 herunterladen',
      feedHeadingDefault: 'Aktuelle Nachrichten der letzten Stunden',
      newVideosBtn: 'Neue Videos',
      timeFilter: {
        none: 'Relevanteste',
        hour: 'Letzte Stunden',
        day: 'Heute (24h)',
        week: 'Diese Woche',
        month: 'Dieser Monat'
      },
      searchBaixatubePlaceholder: 'Auf BaixaTube suchen...',
      likeBtn: '👍 Mag ich',
      likedBtn: '👍 Gemocht',
      dislikeBtn: '👎 Mag ich nicht',
      dislikedBtn: '👎 Ausgeblendet',
      optionBtn: '⚙️ Option',
      dlMp4Btn: '🎬 MP4 Herunterladen',
      dlMp3Btn: '🎵 MP3 Herunterladen',
      castBtn: '📺 Übertragen',
      trendsTitlePrefix: 'Top 10 Trends bei Google Trends',
      trendsSubtitle: 'Meistgesuchte Themen heute auf Google',
      loadingMoreVideos: '⚡ Weitere Videos werden geladen...',
      nativeLoadingText: 'Direkte Wiedergabe wird gestartet...',
      backToTop: '↑ Oben',
      privateMode: 'Privat',
      urlPlaceholder: 'Privat suchen oder Website eingeben...',
      torConnected: 'Tor: Verbunden',
      adsAllowed: 'Werbung Erlaubt',
      adsBlocked: 'Werbung Blockiert',
      moviesBtn: 'Filme',
      circuitBtn: 'Kanal',
      addBookmarkBtn: 'Hinzufügen',
      openTabs: 'Offene Tabs',
      newTab: 'Neuer Tab',
      saveAllBookmarks: 'Alle als Lesezeichen speichern',
      voiceListening: 'Ich höre zu...',
      voiceSub: 'Sprechen Sie Ihren Befehl.',
      voiceFinish: 'Fertig & Senden',
      voiceCancel: 'Abbrechen',
      musicSearchPlaceholder: 'Was möchtest du auf Papaléguas Music hören?',
      musicChips: {
        ai: '✨ KI Empfiehlt',
        playlist: '📁 Playlists ▾',
        all: 'Alle',
        track: 'Titel',
        artist: 'Künstler',
        album: 'Alben',
        podcast: 'Podcasts'
      },
      genresTitle: 'Musikgenres & Stile',
      genresBadge: '🎵 Stil-Karussell',
      equalizer: 'Equalizer',
      cinemaTitle: 'Filme Online',
      cinemaSearchPlaceholder: 'Ganze Filme auf Deutsch suchen...',
      cinemaSearchBtn: 'Suchen',
      cinemaRefreshBtn: '🎲 Neue Filme Würfeln',
      cinemaRefreshShort: '🎲 Würfeln',
      cinemaSectionTitle: '🍿 Ganze Filme auf Deutsch',
      cinemaCountWord: 'Filme',
      cinemaLoaderText: '🍿 Weitere ganze Filme werden geladen...',
      cinemaCats: {
        todos: '🎬 Alle',
        acao: '💥 Action',
        comedia: '😂 Komödie',
        terror: '👻 Horror',
        suspense: '🔍 Thriller',
        ficcao: '🚀 Sci-Fi',
        aventura: '🏹 Abenteuer',
        animacao: '🦁 Animation',
        luta: '🥋 Kampfkunst'
      },
      cinemaMaximize: '⛶ Maximieren',
      cinemaMinimize: '🗕 Minimieren',
      cinemaMiniPlayer: '🗕 Mini-Player',
      cinemaWatchDirect: '▶ Direkt Ansehen',
      cinemaDlMp4: '🎬 MP4 Laden',
      cinemaDlMp3: '🎵 MP3 Audio',
      cinemaCast: '📺 Übertragen',
      cinemaClose: 'Schließen',
      watchNow: '▶ Jetzt Ansehen'
    },
    it: {
      countryNames: {
        BR: 'Brasile', US: 'Stati Uniti', GB: 'Regno Unito', AR: 'Argentina',
        MX: 'Messico', PT: 'Portogallo', ES: 'Spagna', FR: 'Francia', DE: 'Germania',
        IT: 'Italia', JP: 'Giappone', KR: 'Corea del Sud', CN: 'Cina', RU: 'Russia',
        CA: 'Canada', AU: 'Australia', IN: 'India'
      },
      autoCountryLabel: '🌐 Automatico',
      downloadApp: 'Scarica App',
      chips: {
        'noticias': '📰 Notizie',
        'curtidos': '👍 Per Te',
        'musicas': '🎵 Musica',
        'esportes': '⚽ Sport',
        'financeiro': '💰 Finanza',
        'criptomoedas': '🪙 Cripto',
        'podcasts': '🎙️ Podcast',
        'games': '🎮 Giochi',
        'filmes trailers': '🎬 Film & Trailer',
        'tecnologia': '🚀 Tecnologia',
        'ao vivo': '🔴 Dal Vivo',
        'humor': '😂 Umorismo',
        'em alta': '🔥 Tutto / Tendenze'
      },
      baixatubeSubtitle: 'Guarda senza pubblicità e scarica in MP4 e MP3',
      feedHeadingDefault: 'Notizie delle ultime ore',
      newVideosBtn: 'Nuovi Video',
      timeFilter: {
        none: 'Più Rilevanti',
        hour: 'Ultime Ore',
        day: 'Oggi (24h)',
        week: 'Questa Settimana',
        month: 'Questo Mese'
      },
      searchBaixatubePlaceholder: 'Cerca su BaixaTube...',
      likeBtn: '👍 Mi piace',
      likedBtn: '👍 Piaciuto',
      dislikeBtn: '👎 Non mi piace',
      dislikedBtn: '👎 Nascosto',
      optionBtn: '⚙️ Opzione',
      dlMp4Btn: '🎬 Scarica MP4',
      dlMp3Btn: '🎵 Scarica MP3',
      castBtn: '📺 Trasmetti',
      trendsTitlePrefix: 'Top 10 di Tendenza su Google Trends',
      trendsSubtitle: 'Argomenti più cercati oggi su Google',
      loadingMoreVideos: '⚡ Caricamento di altri video...',
      nativeLoadingText: 'Avvio riproduzione diretta...',
      backToTop: '↑ Su',
      privateMode: 'Privato',
      urlPlaceholder: 'Cerca in privato o inserisci un sito...',
      torConnected: 'Tor: Connesso',
      adsAllowed: 'Annunci Consentiti',
      adsBlocked: 'Annunci Bloccati',
      moviesBtn: 'Film',
      circuitBtn: 'Circuito',
      addBookmarkBtn: 'Aggiungi',
      openTabs: 'Schede aperte',
      newTab: 'Nuova scheda',
      saveAllBookmarks: 'Salva tutte nei preferiti',
      voiceListening: 'Ti sto ascoltando...',
      voiceSub: 'Pronuncia il tuo comando.',
      voiceFinish: 'Invia',
      voiceCancel: 'Annulla',
      musicSearchPlaceholder: 'Cosa vuoi ascoltare su Papaléguas Music?',
      musicChips: {
        ai: '✨ IA Consiglia',
        playlist: '📁 Playlist ▾',
        all: 'Tutto',
        track: 'Brani',
        artist: 'Artisti',
        album: 'Album',
        podcast: 'Podcast'
      },
      genresTitle: 'Generi e Stili Musicali',
      genresBadge: '🎵 Carosello Stili',
      equalizer: 'Equalizzatore',
      cinemaTitle: 'Film Online',
      cinemaSearchPlaceholder: 'Cerca film completi in italiano...',
      cinemaSearchBtn: 'Cerca',
      cinemaRefreshBtn: '🎲 Nuovi Film Casuali',
      cinemaRefreshShort: '🎲 Casuale',
      cinemaSectionTitle: '🍿 Film Completi in Italiano',
      cinemaCountWord: 'film',
      cinemaLoaderText: '🍿 Caricamento di altri film completi...',
      cinemaCats: {
        todos: '🎬 Tutti',
        acao: '💥 Azione',
        comedia: '😂 Commedia',
        terror: '👻 Horror',
        suspense: '🔍 Thriller',
        ficcao: '🚀 Fantascienza',
        aventura: '🏹 Avventura',
        animacao: '🦁 Animazione',
        luta: '🥋 Arti Marziali'
      },
      cinemaMaximize: '⛶ Ingrandisci',
      cinemaMinimize: '🗕 Riduci',
      cinemaMiniPlayer: '🗕 Mini Player',
      cinemaWatchDirect: '▶ Guarda Diretto',
      cinemaDlMp4: '🎬 Scarica MP4',
      cinemaDlMp3: '🎵 Audio MP3',
      cinemaCast: '📺 Trasmetti',
      cinemaClose: 'Chiudi',
      watchNow: '▶ Guarda Ora'
    }
  };

  let currentLang = 'pt';
  let currentCountry = 'BR';

  function getLangForCountry(countryCode) {
    const c = String(countryCode || 'BR').toUpperCase();
    return COUNTRY_TO_LANG[c] || 'en';
  }

  function getHlForCountry(countryCode) {
    const c = String(countryCode || 'BR').toUpperCase();
    return COUNTRY_TO_HL[c] || (getLangForCountry(c) === 'pt' ? 'pt-BR' : 'en-US');
  }

  function applyDomTranslations(lang, countryCode) {
    const d = DICT[lang] || DICT.en;
    const c = String(countryCode || currentCountry || 'BR').toUpperCase();
    currentLang = lang;
    currentCountry = c;

    try {
      document.documentElement.lang = getHlForCountry(c);
      document.documentElement.setAttribute('data-app-lang', lang);
      document.documentElement.setAttribute('data-app-country', c);
    } catch (e) {}

    // 1. BaixaTube / newtab.html
    const subEl = document.getElementById('baixatube-main-subtitle');
    if (subEl) subEl.textContent = d.baixatubeSubtitle;

    const installChipSpan = document.querySelector('#btn-home-install-chip span');
    if (installChipSpan) installChipSpan.textContent = d.downloadApp;

    document.querySelectorAll('.home-yt-chips-track .yt-chip[data-q]').forEach((btn) => {
      const q = (btn.getAttribute('data-q') || '').toLowerCase();
      if (d.chips[q]) btn.textContent = d.chips[q];
    });

    const refreshBtn = document.getElementById('home-feed-refresh-btn');
    if (refreshBtn) {
      const svg = refreshBtn.querySelector('svg');
      refreshBtn.innerHTML = '';
      if (svg) refreshBtn.appendChild(svg);
      refreshBtn.appendChild(document.createTextNode(' ' + d.newVideosBtn));
    }

    const countrySelect = document.getElementById('baixatube-country-badge');
    if (countrySelect) {
      Array.from(countrySelect.options).forEach((opt) => {
        const val = (opt.value || '').toUpperCase();
        if (val === 'AUTO') {
          const flag = (typeof window.COUNTRY_FLAGS_MAP === 'object' && window.COUNTRY_FLAGS_MAP[c]) || '🌍';
          opt.textContent = `${d.autoCountryLabel} (${flag} ${c})`;
        } else if (d.countryNames[val]) {
          const m = opt.textContent.match(/^(\S+)\s+/);
          const prefix = m ? m[1] + ' ' : '';
          opt.textContent = prefix + d.countryNames[val];
        }
      });
    }

    const timeSelect = document.getElementById('time-filter-select');
    if (timeSelect) {
      Array.from(timeSelect.options).forEach((opt) => {
        if (d.timeFilter[opt.value]) opt.textContent = d.timeFilter[opt.value];
      });
    }

    const ytSearchInput = document.getElementById('home-yt-search-input');
    if (ytSearchInput) ytSearchInput.placeholder = d.searchBaixatubePlaceholder;

    const likeBtn = document.getElementById('home-btn-like-active');
    if (likeBtn) {
      const isLiked = likeBtn.classList.contains('is-liked');
      likeBtn.textContent = isLiked ? d.likedBtn : d.likeBtn;
    }
    const dislikeBtn = document.getElementById('home-btn-dislike-active');
    if (dislikeBtn) {
      const isDisliked = dislikeBtn.classList.contains('is-disliked');
      dislikeBtn.textContent = isDisliked ? d.dislikedBtn : d.dislikeBtn;
    }
    const optBtn = document.getElementById('home-btn-options-toggle');
    if (optBtn) optBtn.textContent = d.optionBtn;
    const dlMp4 = document.getElementById('home-btn-dl-mp4');
    if (dlMp4) dlMp4.textContent = d.dlMp4Btn;
    const dlMp3 = document.getElementById('home-btn-dl-mp3');
    if (dlMp3) dlMp3.textContent = d.dlMp3Btn;
    const castBtn = document.getElementById('home-btn-cast');
    if (castBtn) castBtn.textContent = d.castBtn;

    const trendsTitle = document.getElementById('google-trends-badge-title');
    if (trendsTitle) {
      const cName = d.countryNames[c] || c;
      const flagMatch = trendsTitle.textContent.match(/\(([^\s()]+)\s+[^()]+\)/);
      const flag = flagMatch ? flagMatch[1] : '🌍';
      trendsTitle.textContent = `${d.trendsTitlePrefix} (${flag} ${cName}):`;
    }
    const trendsSub = document.querySelector('.trends-badge-subtitle');
    if (trendsSub) trendsSub.textContent = d.trendsSubtitle;

    const loaderSpan = document.querySelector('#agent-scroll-loader span');
    if (loaderSpan) loaderSpan.textContent = d.loadingMoreVideos;

    const nativeLoadingText = document.getElementById('home-native-loading-text');
    if (nativeLoadingText) nativeLoadingText.textContent = d.nativeLoadingText;

    const backTopBtn = document.getElementById('btn-back-top');
    if (backTopBtn) backTopBtn.textContent = d.backToTop;

    // Cards já renderizados na grade do BaixaTube
    document.querySelectorAll('.yt-card-like-btn').forEach((b) => {
      const liked = b.classList.contains('is-liked');
      b.innerHTML = liked ? `👍 <span>${d.likedBtn.replace(/^👍\s*/, '')}</span>` : `👍 <span>${d.likeBtn.replace(/^👍\s*/, '')}</span>`;
    });

    // 2. Browser Shell (index.html)
    const privSpan = document.querySelector('#private-mode-pill span');
    if (privSpan) privSpan.textContent = d.privateMode;

    const urlInput = document.getElementById('url-input');
    if (urlInput) urlInput.placeholder = d.urlPlaceholder;

    const torLabel = document.getElementById('tor-toggle-label');
    if (torLabel && /Conectado|Connected|Connesso|Verbunden/i.test(torLabel.textContent)) {
      torLabel.textContent = d.torConnected;
    }

    const installAppLabel = document.getElementById('install-app-label');
    if (installAppLabel && installAppLabel.getAttribute('data-os-locked') !== 'true') {
      installAppLabel.textContent = d.downloadApp;
    }

    const moviesSpan = document.querySelector('#btn-movies span');
    if (moviesSpan) moviesSpan.textContent = d.moviesBtn;

    const circuitSpan = document.querySelector('#btn-circuit span');
    if (circuitSpan) circuitSpan.textContent = d.circuitBtn;

    const addBmSpan = document.querySelector('#btn-add-bookmark span');
    if (addBmSpan) addBmSpan.textContent = d.addBookmarkBtn;

    const tabsMenuHeadSpan = document.querySelector('#tabs-menu .tabs-menu-head span');
    if (tabsMenuHeadSpan) tabsMenuHeadSpan.textContent = d.openTabs;

    const tabsMenuNew = document.getElementById('tabs-menu-new');
    if (tabsMenuNew) tabsMenuNew.textContent = d.newTab;

    const tabsMenuSaveAll = document.getElementById('tabs-menu-save-all');
    if (tabsMenuSaveAll) tabsMenuSaveAll.textContent = d.saveAllBookmarks;

    const voiceText = document.getElementById('voice-overlay-text');
    if (voiceText) voiceText.textContent = d.voiceListening;
    const voiceSub = document.getElementById('voice-overlay-sub');
    if (voiceSub) voiceSub.textContent = d.voiceSub;
    const voiceFinish = document.getElementById('btn-voice-finish');
    if (voiceFinish) voiceFinish.textContent = d.voiceFinish;
    const voiceCancel = document.getElementById('btn-voice-cancel');
    if (voiceCancel) voiceCancel.textContent = d.voiceCancel;

    // 3. Papaléguas Music (musica.html)
    const spSearch = document.getElementById('spotify-search-input');
    if (spSearch) spSearch.placeholder = d.musicSearchPlaceholder;

    document.querySelectorAll('.sp-filter-chips .sp-chip[data-type]').forEach((chip) => {
      const t = chip.getAttribute('data-type');
      if (d.musicChips && d.musicChips[t]) chip.textContent = d.musicChips[t];
    });

    const genresTitle = document.querySelector('.sp-genres-title');
    if (genresTitle) genresTitle.textContent = d.genresTitle;
    const genresBadge = document.querySelector('.sp-genres-badge');
    if (genresBadge) genresBadge.textContent = d.genresBadge;
    const eqStrong = document.querySelector('.sp-eq-title strong');
    if (eqStrong) eqStrong.textContent = d.equalizer;

    // 4. Cinema (/filmes)
    const isCinemaPage = !!(document.querySelector('.movies-grid') || document.getElementById('cinema-iframe'));
    const cinemaTitleEl = document.querySelector('.cinema-title');
    if (cinemaTitleEl && d.cinemaTitle) cinemaTitleEl.textContent = d.cinemaTitle;
    if (isCinemaPage && d.cinemaTitle) {
      document.title = `${d.cinemaTitle} - Cinema Papaléguas`;
    }
    const cinemaQuery = document.getElementById('cinema-query');
    if (cinemaQuery) cinemaQuery.placeholder = d.cinemaSearchPlaceholder;
    const cinemaSearchBtn = document.querySelector('.cinema-search-btn');
    if (cinemaSearchBtn && d.cinemaSearchBtn) {
      const svg = cinemaSearchBtn.querySelector('svg');
      cinemaSearchBtn.innerHTML = '';
      if (svg) cinemaSearchBtn.appendChild(svg);
      cinemaSearchBtn.appendChild(document.createTextNode(' ' + d.cinemaSearchBtn));
    }
    const cinemaRefreshBtn = document.getElementById('cinema-refresh-btn') || document.querySelector('.topbar-actions a.cinema-refresh-btn');
    if (cinemaRefreshBtn && d.cinemaRefreshBtn) cinemaRefreshBtn.textContent = d.cinemaRefreshBtn;
    const cinemaRefreshShort = document.getElementById('cinema-refresh-short-btn') || document.querySelector('.section-header a');
    if (cinemaRefreshShort && d.cinemaRefreshShort) cinemaRefreshShort.textContent = d.cinemaRefreshShort;
    const cinemaSecTitle = document.querySelector('.section-title-text');
    if (cinemaSecTitle && d.cinemaSectionTitle) cinemaSecTitle.textContent = d.cinemaSectionTitle;
    const cinemaCounter = document.querySelector('.section-counter');
    if (cinemaCounter && d.cinemaCountWord) {
      const numMatch = cinemaCounter.textContent.match(/\d+/);
      if (numMatch) cinemaCounter.textContent = `${numMatch[0]} ${d.cinemaCountWord}`;
    }
    const cinemaLoaderSpan = document.querySelector('#cinema-scroll-loader span');
    if (cinemaLoaderSpan && d.cinemaLoaderText) cinemaLoaderSpan.textContent = d.cinemaLoaderText;
    if (d.cinemaCats) {
      document.querySelectorAll('.categories-bar .category-chip').forEach((chip) => {
        const href = chip.getAttribute('href') || '';
        const m = href.match(/[?&]cat=([^&]+)/);
        const catId = chip.getAttribute('data-cat') || (m ? m[1] : '');
        if (catId && d.cinemaCats[catId]) chip.textContent = d.cinemaCats[catId];
        if (href && c) {
          const cleanHref = href.replace(/&country=[A-Za-z]+/g, '');
          chip.setAttribute('href', cleanHref + '&country=' + encodeURIComponent(c));
        }
      });
    }
    const fsLabel = document.getElementById('cinema-fs-label');
    if (fsLabel && d.cinemaMaximize) {
      const isFs = document.documentElement.classList.contains('video-true-fs');
      fsLabel.textContent = isFs ? d.cinemaMinimize : d.cinemaMaximize;
    }
    const miniToggle = document.getElementById('btn-cinema-mini-toggle');
    if (miniToggle && d.cinemaMiniPlayer) miniToggle.textContent = d.cinemaMiniPlayer;
    const directLink = document.getElementById('cinema-direct-link');
    if (directLink && d.cinemaWatchDirect) directLink.textContent = d.cinemaWatchDirect;
    const dlMp4Cinema = document.querySelector('.cinema-dl-mp4');
    if (dlMp4Cinema && d.cinemaDlMp4) dlMp4Cinema.textContent = d.cinemaDlMp4;
    const dlMp3Cinema = document.querySelector('.cinema-dl-mp3');
    if (dlMp3Cinema && d.cinemaDlMp3) dlMp3Cinema.textContent = d.cinemaDlMp3;
    const castQuickBtn = document.getElementById('btn-cast-quick');
    if (castQuickBtn && d.cinemaCast) castQuickBtn.textContent = d.cinemaCast;
    document.querySelectorAll('.movie-card-actions .movie-act-cast').forEach((b) => {
      if (d.cinemaCast) b.textContent = d.cinemaCast;
    });

    // Garante que o seletor de país exista no topo da página /filmes
    let cinemaCountrySelect = document.getElementById('cinema-country-badge');
    if (isCinemaPage && !cinemaCountrySelect) {
      const topbarTitle = document.querySelector('.topbar-title');
      if (topbarTitle) {
        cinemaCountrySelect = document.createElement('select');
        cinemaCountrySelect.id = 'cinema-country-badge';
        cinemaCountrySelect.style.cssText = 'background:rgba(15,23,42,0.85);border:1px solid rgba(255,255,255,0.16);color:#f8fafc;padding:6px 10px;border-radius:10px;font-size:12px;font-weight:700;cursor:pointer;outline:none;';
        const flags = { BR: '🇧🇷', US: '🇺🇸', PT: '🇵🇹', ES: '🇪🇸', MX: '🇲🇽', AR: '🇦🇷', FR: '🇫🇷', DE: '🇩🇪', IT: '🇮🇹', GB: '🇬🇧', CA: '🇨🇦', AU: '🇦🇺', JP: '🇯🇵' };
        const opts = ['auto', 'BR', 'US', 'PT', 'ES', 'MX', 'AR', 'FR', 'DE', 'IT', 'GB', 'CA', 'AU', 'JP'];
        opts.forEach((code) => {
          const o = document.createElement('option');
          o.value = code;
          if (code === 'auto') {
            o.setAttribute('data-flag', flags[c] || '🌍');
            o.setAttribute('data-detected', c);
            o.textContent = `${d.autoCountryLabel} (${flags[c] || '🌍'} ${c})`;
          } else {
            o.textContent = `${flags[code] || '🌍'} ${d.countryNames[code] || code}`;
          }
          cinemaCountrySelect.appendChild(o);
        });
        const urlParams = new URLSearchParams(window.location.search || '');
        const urlC = (urlParams.get('country') || '').toUpperCase();
        let savedManual = '';
        try { savedManual = localStorage.getItem('papaleguas_baixatube_country') || ''; } catch (e) {}
        if (urlC && flags[urlC]) cinemaCountrySelect.value = urlC;
        else if (savedManual && savedManual !== 'auto' && flags[savedManual.toUpperCase()]) cinemaCountrySelect.value = savedManual.toUpperCase();
        else cinemaCountrySelect.value = 'auto';

        cinemaCountrySelect.addEventListener('change', () => {
          const val = String(cinemaCountrySelect.value || 'auto').trim();
          try { localStorage.setItem('papaleguas_baixatube_country', val); } catch (e) {}
          const p = new URLSearchParams(window.location.search || '');
          if (val && val !== 'auto') p.set('country', val.toUpperCase());
          else p.delete('country');
          p.set('r', String(Date.now()));
          window.location.href = '/filmes?' + p.toString();
        });
        topbarTitle.appendChild(cinemaCountrySelect);
      }
    }
    if (cinemaCountrySelect) {
      Array.from(cinemaCountrySelect.options).forEach((opt) => {
        const val = (opt.value || '').toUpperCase();
        if (val === 'AUTO') {
          const flag = opt.getAttribute('data-flag') || '🌍';
          const detCode = opt.getAttribute('data-detected') || c;
          opt.textContent = `${d.autoCountryLabel} (${flag} ${detCode})`;
        } else if (d.countryNames[val]) {
          const m = opt.textContent.match(/^(\S+)\s+/);
          const prefix = m ? m[1] + ' ' : '';
          opt.textContent = prefix + d.countryNames[val];
        }
      });
    }
    document.querySelectorAll('.watch-now-btn').forEach((btn) => {
      btn.textContent = d.watchNow;
    });

    // Sincroniza catálogo de filmes de /filmes com o país do IP ou país selecionado
    if (isCinemaPage && c) {
      syncCinemaCatalogForCountry(c, lang, d);
    }
  }

  let lastSyncedCinemaCountryKey = '';
  async function syncCinemaCatalogForCountry(countryCode, lang, d) {
    const c = String(countryCode || 'BR').toUpperCase();
    const serverRenderedCountry = (document.documentElement.getAttribute('data-country') || '').toUpperCase();
    const urlParams = new URLSearchParams(window.location.search || '');
    const catId = urlParams.get('cat') || 'todos';
    const qParam = urlParams.get('q') || '';
    const vParam = urlParams.get('v') || '';
    const syncKey = `${c}:${catId}:${qParam}`;

    // Se o servidor já renderizou nativamente para este exato país, não precisa recarregar
    if (serverRenderedCountry === c || lastSyncedCinemaCountryKey === syncKey) return;
    // Se não há atributo data-country (servidor em memória antigo) e o país é BR/PT sem filtro explícito, já está em PT
    if (!serverRenderedCountry && (c === 'BR' || c === 'PT') && !urlParams.get('country')) {
      lastSyncedCinemaCountryKey = syncKey;
      return;
    }
    lastSyncedCinemaCountryKey = syncKey;

    try {
      const res = await fetch('/api/curator-recommendations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'cinema',
          currentCategory: catId,
          currentQuery: qParam || catId,
          country: c,
          isManualCountry: true,
          page: 1
        })
      }).then((r) => r.json());

      if (!res || !res.success || !Array.isArray(res.items) || res.items.length === 0) return;

      const items = res.items;
      const grid = document.querySelector('.movies-grid');
      const hl = getHlForCountry(c);
      const langShort = String(hl || 'en').split('-')[0].toLowerCase();
      const defaultChannel = lang === 'pt' ? 'Cinema Dublado' : (lang === 'es' ? 'Cine en Español' : (lang === 'fr' ? 'Cinéma VF' : (lang === 'de' ? 'Kino Deutsch' : (lang === 'it' ? 'Cinema Italiano' : 'Full Movies HD'))));

      // Atualiza o filme em destaque no player se nenhum ?v= específico foi passado
      if (!vParam && items[0]) {
        const first = items[0];
        window.currentCinemaVid = first.id;
        window.currentCinemaTitle = first.title;
        const titleEl = document.getElementById('active-title');
        if (titleEl) titleEl.textContent = '▶ ' + first.title;
        const directBtn = document.getElementById('cinema-direct-link');
        if (directBtn) directBtn.href = 'https://www.youtube.com/watch?v=' + encodeURIComponent(first.id);
        const iframe = document.getElementById('cinema-iframe');
        if (iframe) {
          const originEnc = encodeURIComponent(window.location.origin || 'http://localhost:8080');
          iframe.src = `https://www.youtube.com/embed/${encodeURIComponent(first.id)}?autoplay=0&enablejsapi=1&playsinline=1&hl=${encodeURIComponent(hl)}&cc_lang_pref=${encodeURIComponent(langShort)}&rel=0&origin=${originEnc}&widget_referrer=${originEnc}`;
        }
      }

      if (grid) {
        grid.innerHTML = '';
        items.forEach((m) => {
          if (!m || !m.id) return;
          const card = document.createElement('article');
          card.className = 'movie-card';
          card.setAttribute('data-id', m.id);
          card.setAttribute('data-title', m.title || '');
          const safeTitle = String(m.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const safeAttrTitle = String(m.title || '').replace(/"/g, '&quot;');
          const safeChan = String(m.channel || defaultChannel).replace(/</g, '&lt;').replace(/>/g, '&gt;');
          card.innerHTML = `
            <div class="movie-thumb-wrap">
              <img src="${m.thumbnail}" alt="${safeAttrTitle}" loading="lazy">
              ${m.duration ? `<span class="movie-dur">${m.duration}</span>` : ''}
            </div>
            <div class="movie-details">
              <h2 class="movie-title">${safeTitle}</h2>
              <div class="movie-channel">${safeChan}</div>
              <div class="movie-card-actions">
                <button type="button" onclick="event.stopPropagation(); openCinemaResolutionModal('${m.id}', this)">🎬 MP4</button>
                <button type="button" class="movie-act-mp3" onclick="event.stopPropagation(); downloadActiveCinemaVideo('mp3', '${m.id}', this)">🎵 MP3</button>
                <button type="button" class="movie-act-cast" onclick="event.stopPropagation(); openCinemaCastForMovie('${m.id}', this)">${d.cinemaCast || '📺 Cast'}</button>
              </div>
            </div>
          `;
          card.addEventListener('click', (e) => {
            if (e && e.target && (e.target.closest('button') || e.target.closest('.cinema-actions'))) return;
            window.currentCinemaVid = m.id;
            window.currentCinemaTitle = m.title || '';
            const titleEl = document.getElementById('active-title');
            if (titleEl) titleEl.textContent = '▶ ' + (m.title || '');
            const directBtn = document.getElementById('cinema-direct-link');
            if (directBtn) directBtn.href = 'https://www.youtube.com/watch?v=' + encodeURIComponent(m.id);
            const iframe = document.getElementById('cinema-iframe');
            if (iframe) {
              const originEnc = encodeURIComponent(window.location.origin || 'http://localhost:8080');
              iframe.style.display = '';
              iframe.src = `https://www.youtube.com/embed/${encodeURIComponent(m.id)}?autoplay=1&enablejsapi=1&playsinline=1&hl=${encodeURIComponent(hl)}&cc_lang_pref=${encodeURIComponent(langShort)}&fs=1&rel=0&origin=${originEnc}&widget_referrer=${originEnc}`;
            }
            if (typeof window.maximizeCinemaVideo === 'function') {
              window.maximizeCinemaVideo();
            }
            window.scrollTo({ top: 0, behavior: 'smooth' });
          });
          grid.appendChild(card);
        });
        const cinemaCounter = document.querySelector('.section-counter');
        if (cinemaCounter && d.cinemaCountWord) {
          cinemaCounter.textContent = `${items.length} ${d.cinemaCountWord}`;
        }
      }
    } catch (err) {
      console.warn('[Cinema IP Sync]', err);
    }
  }

  function applyCountryLanguage(countryCode) {
    if (!countryCode || !/^[A-Z]{2}$/i.test(countryCode)) return;
    const c = countryCode.toUpperCase();
    try {
      localStorage.setItem('papaleguas_detected_ip_country', c);
    } catch (e) {}
    const lang = getLangForCountry(c);
    applyDomTranslations(lang, c);
  }

  async function detectAndApplyIpLanguage() {
    let urlCountry = '';
    try {
      const p = new URLSearchParams(window.location.search || '');
      const rawUrlC = (p.get('country') || '').trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(rawUrlC)) urlCountry = rawUrlC;
    } catch (e) {}

    // 1. Aplica imediatamente o país da URL, seleção manual ou último país detectado em cache para evitar atraso visual
    try {
      const manual = localStorage.getItem('papaleguas_baixatube_country');
      const cachedIpCountry = localStorage.getItem('papaleguas_detected_ip_country');
      const initialCountry = urlCountry
        ? urlCountry
        : (manual && manual !== 'auto' && /^[A-Z]{2}$/i.test(manual))
          ? manual.toUpperCase()
          : (cachedIpCountry && /^[A-Z]{2}$/i.test(cachedIpCountry) ? cachedIpCountry.toUpperCase() : '');
      if (initialCountry) {
        applyDomTranslations(getLangForCountry(initialCountry), initialCountry);
      }
    } catch (e) {}

    // 2. Consulta o IP real da conexão no servidor e aplica o idioma correspondente ao país do IP
    try {
      const res = await fetch('/api/country-detect', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.country && /^[A-Z]{2}$/i.test(data.country)) {
        try { localStorage.setItem('papaleguas_detected_ip_country', data.country.toUpperCase()); } catch (e) {}
        const manual = localStorage.getItem('papaleguas_baixatube_country');
        const effective = urlCountry
          ? urlCountry
          : (manual && manual !== 'auto' && /^[A-Z]{2}$/i.test(manual))
            ? manual.toUpperCase()
            : data.country.toUpperCase();
        applyDomTranslations(getLangForCountry(effective), effective);
      }
    } catch (e) {}
  }

  window.PapaleguasI18n = {
    DICT,
    getLang: () => currentLang,
    getCountry: () => currentCountry,
    getLangForCountry,
    getHlForCountry,
    applyCountryLanguage,
    applyDomTranslations,
    detectAndApplyIpLanguage,
    t: (key) => {
      const d = DICT[currentLang] || DICT.pt;
      return d[key] !== undefined ? d[key] : (DICT.pt[key] || key);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', detectAndApplyIpLanguage);
  } else {
    detectAndApplyIpLanguage();
  }
})();
