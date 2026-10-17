import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { injectExifIntoJpeg, type RawExifInput } from './exifWriter.ts';

export interface DemoPhotoSpec {
  subfolder: string;
  fileName: string;
  title: string;
  dateIso: string;
  lat?: number;
  lng?: number;
  locationName?: string;
  make: string;
  model: string;
  lensModel: string;
  focalLength: number;
  fNumber: number;
  exposureTime: [number, number];
  iso: number;
  theme: 'dawn' | 'morning' | 'day' | 'golden' | 'twilight' | 'night' | 'aurora' | 'desert' | 'studio';
  accent: string;
  motif: 'tokyo' | 'paris' | 'iceland' | 'ny' | 'cairo' | 'sydney' | 'studio';
}

export const DEMO_PHOTO_SPECS: DemoPhotoSpec[] = [
  // Day 1: 2025-03-14 — Tokyo Day 1 (Shibuya & Shinjuku)
  {
    subfolder: '2025-03-Tokyo-Spring/Day1-Shibuya',
    fileName: 'IMG_1001_Meiji_Shrine_Mist.jpg',
    title: 'Meiji Shrine Morning Mist',
    dateIso: '2025-03-14T07:15:00.000Z',
    lat: 35.6764,
    lng: 139.6993,
    locationName: 'Meiji Jingu, Shibuya, Tokyo',
    make: 'Sony',
    model: 'ILCE-7RM5',
    lensModel: 'FE 24-70mm F2.8 GM II',
    focalLength: 35,
    fNumber: 2.8,
    exposureTime: [1, 250],
    iso: 160,
    theme: 'dawn',
    accent: '#f472b6',
    motif: 'tokyo',
  },
  {
    subfolder: '2025-03-Tokyo-Spring/Day1-Shibuya',
    fileName: 'IMG_1002_Harajuku_Alley.jpg',
    title: 'Harajuku Cat Street Morning',
    dateIso: '2025-03-14T10:30:00.000Z',
    lat: 35.6654,
    lng: 139.7058,
    locationName: 'Cat Street, Harajuku, Tokyo',
    make: 'Sony',
    model: 'ILCE-7RM5',
    lensModel: 'FE 35mm F1.4 GM',
    focalLength: 35,
    fNumber: 2.0,
    exposureTime: [1, 800],
    iso: 100,
    theme: 'morning',
    accent: '#38bdf8',
    motif: 'tokyo',
  },
  {
    subfolder: '2025-03-Tokyo-Spring/Day1-Shibuya',
    fileName: 'IMG_1003_Shibuya_Sky_Vista.jpg',
    title: 'Shibuya Sky Rooftop Horizon',
    dateIso: '2025-03-14T13:45:00.000Z',
    lat: 35.6585,
    lng: 139.7022,
    locationName: 'Shibuya Sky, Tokyo',
    make: 'Sony',
    model: 'ILCE-7RM5',
    lensModel: 'FE 16-35mm F2.8 GM II',
    focalLength: 16,
    fNumber: 8.0,
    exposureTime: [1, 1000],
    iso: 100,
    theme: 'day',
    accent: '#0ea5e9',
    motif: 'tokyo',
  },
  {
    subfolder: '2025-03-Tokyo-Spring/Day1-Shibuya',
    fileName: 'IMG_1004_Shibuya_Crossing_Dusk.jpg',
    title: 'Shibuya Crossing Golden Hour',
    dateIso: '2025-03-14T17:50:00.000Z',
    lat: 35.6595,
    lng: 139.7004,
    locationName: 'Shibuya Scramble Crossing, Tokyo',
    make: 'Sony',
    model: 'ILCE-7RM5',
    lensModel: 'FE 24-70mm F2.8 GM II',
    focalLength: 28,
    fNumber: 4.0,
    exposureTime: [1, 125],
    iso: 400,
    theme: 'golden',
    accent: '#f97316',
    motif: 'tokyo',
  },
  {
    subfolder: '2025-03-Tokyo-Spring/Day1-Shibuya',
    fileName: 'IMG_1005_Omoide_Yokocho_Lanterns.jpg',
    title: 'Omoide Yokocho Izakaya Glow',
    dateIso: '2025-03-14T20:15:00.000Z',
    lat: 35.6930,
    lng: 139.6995,
    locationName: 'Omoide Yokocho, Shinjuku, Tokyo',
    make: 'Sony',
    model: 'ILCE-7RM5',
    lensModel: 'FE 35mm F1.4 GM',
    focalLength: 35,
    fNumber: 1.4,
    exposureTime: [1, 160],
    iso: 1250,
    theme: 'night',
    accent: '#ef4444',
    motif: 'tokyo',
  },
  {
    subfolder: '2025-03-Tokyo-Spring/Day1-Shibuya',
    fileName: 'IMG_1006_Kabukicho_Neon_Rain.jpg',
    title: 'Kabukicho Midnight Neon Reflections',
    dateIso: '2025-03-14T22:40:00.000Z',
    lat: 35.6946,
    lng: 139.7034,
    locationName: 'Kabukicho, Shinjuku, Tokyo',
    make: 'Sony',
    model: 'ILCE-7RM5',
    lensModel: 'FE 50mm F1.2 GM',
    focalLength: 50,
    fNumber: 1.2,
    exposureTime: [1, 200],
    iso: 1600,
    theme: 'night',
    accent: '#ec4899',
    motif: 'tokyo',
  },

  // Day 2: 2025-03-15 — Tokyo Day 2 (Asakusa & Bay)
  {
    subfolder: '2025-03-Tokyo-Spring/Day2-Asakusa',
    fileName: 'IMG_1007_Sensoji_Dawn_Gate.jpg',
    title: 'Senso-ji Kaminarimon at Dawn',
    dateIso: '2025-03-15T06:30:00.000Z',
    lat: 35.7148,
    lng: 139.7967,
    locationName: 'Senso-ji Temple, Asakusa, Tokyo',
    make: 'Fujifilm',
    model: 'X-T5',
    lensModel: 'XF 23mm F1.4 R LM WR',
    focalLength: 23,
    fNumber: 2.8,
    exposureTime: [1, 320],
    iso: 160,
    theme: 'dawn',
    accent: '#fb7185',
    motif: 'tokyo',
  },
  {
    subfolder: '2025-03-Tokyo-Spring/Day2-Asakusa',
    fileName: 'IMG_1008_Sumida_Sakura_Walk.jpg',
    title: 'Sumida River Sakura Blossoms',
    dateIso: '2025-03-15T09:45:00.000Z',
    lat: 35.7122,
    lng: 139.8012,
    locationName: 'Sumida Park, Tokyo',
    make: 'Fujifilm',
    model: 'X-T5',
    lensModel: 'XF 56mm F1.2 R WR',
    focalLength: 56,
    fNumber: 2.0,
    exposureTime: [1, 1250],
    iso: 125,
    theme: 'morning',
    accent: '#f9a8d4',
    motif: 'tokyo',
  },
  {
    subfolder: '2025-03-Tokyo-Spring/Day2-Asakusa',
    fileName: 'IMG_1009_Tsukiji_Market_Noon.jpg',
    title: 'Tsukiji Market Street Craft',
    dateIso: '2025-03-15T12:20:00.000Z',
    lat: 35.6655,
    lng: 139.7707,
    locationName: 'Tsukiji Outer Market, Tokyo',
    make: 'Fujifilm',
    model: 'X-T5',
    lensModel: 'XF 23mm F1.4 R LM WR',
    focalLength: 23,
    fNumber: 4.0,
    exposureTime: [1, 640],
    iso: 125,
    theme: 'day',
    accent: '#38bdf8',
    motif: 'tokyo',
  },
  {
    subfolder: '2025-03-Tokyo-Spring/Day2-Asakusa',
    fileName: 'IMG_1010_Ueno_Cherry_Canopy.jpg',
    title: 'Ueno Park Blossom Canopy',
    dateIso: '2025-03-15T16:10:00.000Z',
    lat: 35.7156,
    lng: 139.7741,
    locationName: 'Ueno Onshi Park, Tokyo',
    make: 'Fujifilm',
    model: 'X-T5',
    lensModel: 'XF 16-55mm F2.8 R LM WR',
    focalLength: 35,
    fNumber: 4.0,
    exposureTime: [1, 500],
    iso: 200,
    theme: 'golden',
    accent: '#f472b6',
    motif: 'tokyo',
  },
  {
    subfolder: '2025-03-Tokyo-Spring/Day2-Asakusa',
    fileName: 'IMG_1011_Tokyo_Tower_Twilight.jpg',
    title: 'Tokyo Tower Blue Hour Spire',
    dateIso: '2025-03-15T18:45:00.000Z',
    lat: 35.6586,
    lng: 139.7454,
    locationName: 'Tokyo Tower, Minato, Tokyo',
    make: 'Fujifilm',
    model: 'X-T5',
    lensModel: 'XF 56mm F1.2 R WR',
    focalLength: 56,
    fNumber: 2.2,
    exposureTime: [1, 80],
    iso: 640,
    theme: 'twilight',
    accent: '#fb923c',
    motif: 'tokyo',
  },
  {
    subfolder: '2025-03-Tokyo-Spring/Day2-Asakusa',
    fileName: 'IMG_1012_Odaiba_Bay_Lights.jpg',
    title: 'Rainbow Bridge Across Tokyo Bay',
    dateIso: '2025-03-15T21:30:00.000Z',
    lat: 35.6308,
    lng: 139.7762,
    locationName: 'Odaiba Marine Park, Tokyo',
    make: 'Fujifilm',
    model: 'X-T5',
    lensModel: 'XF 16-55mm F2.8 R LM WR',
    focalLength: 24,
    fNumber: 8.0,
    exposureTime: [2, 1],
    iso: 125,
    theme: 'night',
    accent: '#818cf8',
    motif: 'tokyo',
  },

  // Unlocated Tokyo shots for auto-locate: 1013 is 20 min from a located photo, 1014 and 1015 sit inside the 13:45-17:50 segment
  {
    subfolder: '2025-03-Tokyo-Spring/Day1-Shibuya',
    fileName: 'IMG_1013_Shibuya_Scramble_Umbrellas.jpg',
    title: 'Shibuya Scramble Umbrella Crowd',
    dateIso: '2025-03-14T18:10:00.000Z',
    make: 'Sony',
    model: 'ILCE-7RM5',
    lensModel: 'FE 24-70mm F2.8 GM II',
    focalLength: 40,
    fNumber: 2.8,
    exposureTime: [1, 200],
    iso: 800,
    theme: 'twilight',
    accent: '#facc15',
    motif: 'tokyo',
  },
  {
    subfolder: '2025-03-Tokyo-Spring/Day1-Shibuya',
    fileName: 'IMG_1014_Shibuya_Sky_Rooftop_Walk.jpg',
    title: 'Shibuya Sky Rooftop Walkway Study',
    dateIso: '2025-03-14T14:37:00.000Z',
    make: 'Sony',
    model: 'ILCE-7RM5',
    lensModel: 'FE 16-35mm F2.8 GM II',
    focalLength: 20,
    fNumber: 8.0,
    exposureTime: [1, 800],
    iso: 100,
    theme: 'day',
    accent: '#7dd3fc',
    motif: 'tokyo',
  },
  {
    subfolder: '2025-03-Tokyo-Spring/Day1-Shibuya',
    fileName: 'IMG_1015_Harajuku_Takeshita_Crepes.jpg',
    title: 'Harajuku Takeshita Crepe Stand',
    dateIso: '2025-03-14T15:48:00.000Z',
    make: 'Sony',
    model: 'ILCE-7RM5',
    lensModel: 'FE 35mm F1.4 GM',
    focalLength: 35,
    fNumber: 2.0,
    exposureTime: [1, 640],
    iso: 200,
    theme: 'day',
    accent: '#f9a8d4',
    motif: 'tokyo',
  },

  // Day 3: 2025-05-20 — Paris Lumiere
  {
    subfolder: '2025-05-Paris-Lumiere',
    fileName: 'IMG_2001_Trocadero_Sunrise.jpg',
    title: 'Eiffel Silhouette from Trocadero',
    dateIso: '2025-05-20T06:50:00.000Z',
    lat: 48.8616,
    lng: 2.2893,
    locationName: 'Place du Trocadero, Paris',
    make: 'Leica',
    model: 'Leica Q3',
    lensModel: 'Summilux 28mm f/1.7 ASPH.',
    focalLength: 28,
    fNumber: 2.8,
    exposureTime: [1, 400],
    iso: 100,
    theme: 'dawn',
    accent: '#fda4af',
    motif: 'paris',
  },
  {
    subfolder: '2025-05-Paris-Lumiere',
    fileName: 'IMG_2002_Louvre_Geometry.jpg',
    title: 'Cour Napoleon Pyramid Geometry',
    dateIso: '2025-05-20T10:15:00.000Z',
    lat: 48.8606,
    lng: 2.3376,
    locationName: 'Musee du Louvre, Paris',
    make: 'Leica',
    model: 'Leica Q3',
    lensModel: 'Summilux 28mm f/1.7 ASPH.',
    focalLength: 28,
    fNumber: 5.6,
    exposureTime: [1, 1000],
    iso: 64,
    theme: 'morning',
    accent: '#38bdf8',
    motif: 'paris',
  },
  {
    subfolder: '2025-05-Paris-Lumiere',
    fileName: 'IMG_2003_Luxembourg_Gardens.jpg',
    title: 'Jardin du Luxembourg Fountain',
    dateIso: '2025-05-20T13:30:00.000Z',
    lat: 48.8462,
    lng: 2.3372,
    locationName: 'Jardin du Luxembourg, Paris',
    make: 'Leica',
    model: 'Leica Q3',
    lensModel: 'Summilux 28mm f/1.7 ASPH.',
    focalLength: 28,
    fNumber: 4.0,
    exposureTime: [1, 1250],
    iso: 64,
    theme: 'day',
    accent: '#34d399',
    motif: 'paris',
  },
  {
    subfolder: '2025-05-Paris-Lumiere',
    fileName: 'IMG_2004_Montmartre_Steps.jpg',
    title: 'Montmartre Cobblestones & Domes',
    dateIso: '2025-05-20T16:45:00.000Z',
    lat: 48.8867,
    lng: 2.3431,
    locationName: 'Sacre-Coeur, Montmartre, Paris',
    make: 'Leica',
    model: 'Leica Q3',
    lensModel: 'Summilux 28mm f/1.7 ASPH.',
    focalLength: 28,
    fNumber: 2.8,
    exposureTime: [1, 640],
    iso: 100,
    theme: 'golden',
    accent: '#fbbf24',
    motif: 'paris',
  },
  {
    subfolder: '2025-05-Paris-Lumiere',
    fileName: 'IMG_2005_Pont_Alexandre_Sunset.jpg',
    title: 'Pont Alexandre III Golden Seine',
    dateIso: '2025-05-20T19:55:00.000Z',
    lat: 48.8639,
    lng: 2.3135,
    locationName: 'Pont Alexandre III, Paris',
    make: 'Leica',
    model: 'Leica Q3',
    lensModel: 'Summilux 28mm f/1.7 ASPH.',
    focalLength: 28,
    fNumber: 2.0,
    exposureTime: [1, 250],
    iso: 200,
    theme: 'golden',
    accent: '#f59e0b',
    motif: 'paris',
  },
  {
    subfolder: '2025-05-Paris-Lumiere',
    fileName: 'IMG_2006_Eiffel_Sparkle_Night.jpg',
    title: 'Champ de Mars Midnight Sparkle',
    dateIso: '2025-05-20T22:15:00.000Z',
    lat: 48.8584,
    lng: 2.2945,
    locationName: 'Tour Eiffel, Champ de Mars, Paris',
    make: 'Leica',
    model: 'Leica Q3',
    lensModel: 'Summilux 28mm f/1.7 ASPH.',
    focalLength: 28,
    fNumber: 1.7,
    exposureTime: [1, 60],
    iso: 800,
    theme: 'night',
    accent: '#facc15',
    motif: 'paris',
  },

  // Day 4: 2025-07-08 — Iceland Highlands (South Coast)
  {
    subfolder: '2025-07-Iceland-Highlands/South-Coast',
    fileName: 'IMG_3001_Seljalandsfoss_Spray.jpg',
    title: 'Seljalandsfoss Behind the Curtain',
    dateIso: '2025-07-08T08:00:00.000Z',
    lat: 63.6156,
    lng: -19.9886,
    locationName: 'Seljalandsfoss, South Coast, Iceland',
    make: 'Canon',
    model: 'EOS R5',
    lensModel: 'RF 15-35mm F2.8 L IS USM',
    focalLength: 16,
    fNumber: 11,
    exposureTime: [1, 4],
    iso: 100,
    theme: 'morning',
    accent: '#2dd4bf',
    motif: 'iceland',
  },
  {
    subfolder: '2025-07-Iceland-Highlands/South-Coast',
    fileName: 'IMG_3002_Skogafoss_Prism.jpg',
    title: 'Skogafoss Double Rainbow Mist',
    dateIso: '2025-07-08T11:20:00.000Z',
    lat: 63.5321,
    lng: -19.5114,
    locationName: 'Skogafoss Waterfall, Iceland',
    make: 'Canon',
    model: 'EOS R5',
    lensModel: 'RF 24-70mm F2.8 L IS USM',
    focalLength: 24,
    fNumber: 8.0,
    exposureTime: [1, 320],
    iso: 100,
    theme: 'day',
    accent: '#34d399',
    motif: 'iceland',
  },
  {
    subfolder: '2025-07-Iceland-Highlands/South-Coast',
    fileName: 'IMG_3003_Dyrholaey_Arch.jpg',
    title: 'Dyrholaey Volcanic Sea Arch',
    dateIso: '2025-07-08T14:40:00.000Z',
    lat: 63.4017,
    lng: -19.1269,
    locationName: 'Dyrholaey Peninsula, Iceland',
    make: 'Canon',
    model: 'EOS R5',
    lensModel: 'RF 24-70mm F2.8 L IS USM',
    focalLength: 35,
    fNumber: 7.1,
    exposureTime: [1, 500],
    iso: 100,
    theme: 'day',
    accent: '#38bdf8',
    motif: 'iceland',
  },
  {
    subfolder: '2025-07-Iceland-Highlands/South-Coast',
    fileName: 'IMG_3004_Reynisfjara_Basalt.jpg',
    title: 'Reynisfjara Black Sand & Sea Stacks',
    dateIso: '2025-07-08T17:30:00.000Z',
    lat: 63.4042,
    lng: -19.0450,
    locationName: 'Reynisfjara Beach, Vik, Iceland',
    make: 'Canon',
    model: 'EOS R5',
    lensModel: 'RF 15-35mm F2.8 L IS USM',
    focalLength: 20,
    fNumber: 9.0,
    exposureTime: [1, 2],
    iso: 100,
    theme: 'twilight',
    accent: '#60a5fa',
    motif: 'iceland',
  },
  {
    subfolder: '2025-07-Iceland-Highlands/South-Coast',
    fileName: 'IMG_3005_Vik_Lupine_Meadow.jpg',
    title: 'Vik Church & Purple Lupines',
    dateIso: '2025-07-08T20:45:00.000Z',
    lat: 63.4194,
    lng: -19.0046,
    locationName: 'Vik i Myrdal, Iceland',
    make: 'Canon',
    model: 'EOS R5',
    lensModel: 'RF 70-200mm F2.8 L IS USM',
    focalLength: 85,
    fNumber: 4.0,
    exposureTime: [1, 250],
    iso: 200,
    theme: 'golden',
    accent: '#a855f7',
    motif: 'iceland',
  },
  {
    subfolder: '2025-07-Iceland-Highlands/South-Coast',
    fileName: 'IMG_3006_Jokulsarlon_Midnight.jpg',
    title: 'Jokulsarlon Icebergs under Midnight Sun',
    dateIso: '2025-07-08T23:45:00.000Z',
    lat: 64.0484,
    lng: -16.1794,
    locationName: 'Jokulsarlon Glacier Lagoon, Iceland',
    make: 'Canon',
    model: 'EOS R5',
    lensModel: 'RF 24-70mm F2.8 L IS USM',
    focalLength: 50,
    fNumber: 5.6,
    exposureTime: [1, 80],
    iso: 400,
    theme: 'dawn',
    accent: '#67e8f9',
    motif: 'iceland',
  },

  // Day 5: 2025-07-09 — Iceland Highlands (Snaefellsnes & Reykjavik)
  {
    subfolder: '2025-07-Iceland-Highlands/Snaefellsnes',
    fileName: 'IMG_3007_Kirkjufell_Falls.jpg',
    title: 'Kirkjufellsfoss Morning Cascade',
    dateIso: '2025-07-09T07:30:00.000Z',
    lat: 64.9261,
    lng: -23.3122,
    locationName: 'Kirkjufell, Grundarfjordur, Iceland',
    make: 'Canon',
    model: 'EOS R5',
    lensModel: 'RF 15-35mm F2.8 L IS USM',
    focalLength: 18,
    fNumber: 11,
    exposureTime: [1, 5],
    iso: 100,
    theme: 'morning',
    accent: '#10b981',
    motif: 'iceland',
  },
  {
    subfolder: '2025-07-Iceland-Highlands/Snaefellsnes',
    fileName: 'IMG_3008_Arnarstapi_Cliffs.jpg',
    title: 'Arnarstapi Basalt Ravine',
    dateIso: '2025-07-09T10:50:00.000Z',
    lat: 64.7691,
    lng: -23.6219,
    locationName: 'Arnarstapi, Snaefellsnes, Iceland',
    make: 'Canon',
    model: 'EOS R5',
    lensModel: 'RF 24-70mm F2.8 L IS USM',
    focalLength: 28,
    fNumber: 8.0,
    exposureTime: [1, 400],
    iso: 100,
    theme: 'day',
    accent: '#06b6d4',
    motif: 'iceland',
  },
  {
    subfolder: '2025-07-Iceland-Highlands/Snaefellsnes',
    fileName: 'IMG_3009_Budir_Black_Church.jpg',
    title: 'Budakirkja in Lava Fields',
    dateIso: '2025-07-09T14:15:00.000Z',
    lat: 64.8217,
    lng: -23.3844,
    locationName: 'Budir, Snaefellsnes, Iceland',
    make: 'Canon',
    model: 'EOS R5',
    lensModel: 'RF 70-200mm F2.8 L IS USM',
    focalLength: 135,
    fNumber: 4.0,
    exposureTime: [1, 800],
    iso: 100,
    theme: 'day',
    accent: '#94a3b8',
    motif: 'iceland',
  },
  {
    subfolder: '2025-07-Iceland-Highlands/Snaefellsnes',
    fileName: 'IMG_3010_Hallgrimskirkja_Spire.jpg',
    title: 'Hallgrimskirkja Basalt Facade',
    dateIso: '2025-07-09T18:00:00.000Z',
    lat: 64.1417,
    lng: -21.9266,
    locationName: 'Hallgrimskirkja, Reykjavik, Iceland',
    make: 'Canon',
    model: 'EOS R5',
    lensModel: 'RF 24-70mm F2.8 L IS USM',
    focalLength: 35,
    fNumber: 5.6,
    exposureTime: [1, 500],
    iso: 160,
    theme: 'golden',
    accent: '#f59e0b',
    motif: 'iceland',
  },
  {
    subfolder: '2025-07-Iceland-Highlands/Snaefellsnes',
    fileName: 'IMG_3011_Sun_Voyager_Bay.jpg',
    title: 'Solfar Sun Voyager against Mt. Esja',
    dateIso: '2025-07-09T21:10:00.000Z',
    lat: 64.1476,
    lng: -21.9223,
    locationName: 'Sun Voyager, Reykjavik, Iceland',
    make: 'Canon',
    model: 'EOS R5',
    lensModel: 'RF 24-70mm F2.8 L IS USM',
    focalLength: 42,
    fNumber: 4.0,
    exposureTime: [1, 160],
    iso: 250,
    theme: 'twilight',
    accent: '#f43f5e',
    motif: 'iceland',
  },
  {
    subfolder: '2025-07-Iceland-Highlands/Snaefellsnes',
    fileName: 'IMG_3012_Grotta_Aurora_Sky.jpg',
    title: 'Grotta Lighthouse Solar Storm',
    dateIso: '2025-07-09T23:55:00.000Z',
    lat: 64.1647,
    lng: -22.0222,
    locationName: 'Grotta Lighthouse, Seltjarnarnes, Iceland',
    make: 'Canon',
    model: 'EOS R5',
    lensModel: 'RF 15-35mm F2.8 L IS USM',
    focalLength: 15,
    fNumber: 2.8,
    exposureTime: [3, 1],
    iso: 1600,
    theme: 'aurora',
    accent: '#4ade80',
    motif: 'iceland',
  },

  // Day 6: 2025-09-18 — New York Autumn
  {
    subfolder: '2025-09-NewYork-Autumn',
    fileName: 'IMG_4001_Brooklyn_Bridge_Dawn.jpg',
    title: 'Brooklyn Bridge Gothic Arches at Dawn',
    dateIso: '2025-09-18T06:40:00.000Z',
    lat: 40.7061,
    lng: -73.9969,
    locationName: 'Brooklyn Bridge, New York, NY',
    make: 'Hasselblad',
    model: 'X2D 100C',
    lensModel: 'XCD 38mm f/2.5V',
    focalLength: 38,
    fNumber: 4.0,
    exposureTime: [1, 250],
    iso: 64,
    theme: 'dawn',
    accent: '#fb923c',
    motif: 'ny',
  },
  {
    subfolder: '2025-09-NewYork-Autumn',
    fileName: 'IMG_4002_Dumbo_Bridge_Frame.jpg',
    title: 'Washington Street Manhattan Bridge View',
    dateIso: '2025-09-18T09:50:00.000Z',
    lat: 40.7033,
    lng: -73.9896,
    locationName: 'DUMBO, Brooklyn, New York, NY',
    make: 'Hasselblad',
    model: 'X2D 100C',
    lensModel: 'XCD 55mm f/2.5V',
    focalLength: 55,
    fNumber: 4.0,
    exposureTime: [1, 500],
    iso: 64,
    theme: 'morning',
    accent: '#ef4444',
    motif: 'ny',
  },
  {
    subfolder: '2025-09-NewYork-Autumn',
    fileName: 'IMG_4003_Central_Park_Bow_Bridge.jpg',
    title: 'Central Park Bow Bridge Autumn Reflections',
    dateIso: '2025-09-18T12:45:00.000Z',
    lat: 40.7757,
    lng: -73.9717,
    locationName: 'Bow Bridge, Central Park, New York, NY',
    make: 'Hasselblad',
    model: 'X2D 100C',
    lensModel: 'XCD 55mm f/2.5V',
    focalLength: 55,
    fNumber: 5.6,
    exposureTime: [1, 640],
    iso: 64,
    theme: 'day',
    accent: '#f59e0b',
    motif: 'ny',
  },
  {
    subfolder: '2025-09-NewYork-Autumn',
    fileName: 'IMG_4004_Grand_Central_Concourse.jpg',
    title: 'Grand Central Terminal Sunbeams',
    dateIso: '2025-09-18T15:30:00.000Z',
    lat: 40.7527,
    lng: -73.9772,
    locationName: 'Grand Central Terminal, New York, NY',
    make: 'Hasselblad',
    model: 'X2D 100C',
    lensModel: 'XCD 38mm f/2.5V',
    focalLength: 38,
    fNumber: 2.8,
    exposureTime: [1, 125],
    iso: 400,
    theme: 'golden',
    accent: '#fbbf24',
    motif: 'ny',
  },
  {
    subfolder: '2025-09-NewYork-Autumn',
    fileName: 'IMG_4005_Top_Of_The_Rock_Sunset.jpg',
    title: 'Midtown Skyline & Empire State Spire',
    dateIso: '2025-09-18T18:20:00.000Z',
    lat: 40.7591,
    lng: -73.9794,
    locationName: 'Rockefeller Center, New York, NY',
    make: 'Hasselblad',
    model: 'X2D 100C',
    lensModel: 'XCD 90mm f/2.5V',
    focalLength: 90,
    fNumber: 4.0,
    exposureTime: [1, 160],
    iso: 200,
    theme: 'twilight',
    accent: '#f97316',
    motif: 'ny',
  },
  {
    subfolder: '2025-09-NewYork-Autumn',
    fileName: 'IMG_4006_Times_Square_Midnight.jpg',
    title: 'Broadway & 7th Avenue Electric Canyon',
    dateIso: '2025-09-18T21:00:00.000Z',
    lat: 40.7580,
    lng: -73.9855,
    locationName: 'Times Square, Manhattan, New York, NY',
    make: 'Hasselblad',
    model: 'X2D 100C',
    lensModel: 'XCD 38mm f/2.5V',
    focalLength: 38,
    fNumber: 2.5,
    exposureTime: [1, 200],
    iso: 800,
    theme: 'night',
    accent: '#38bdf8',
    motif: 'ny',
  },

  // Day 7: 2025-11-04 — Cairo Desert
  {
    subfolder: '2025-11-Cairo-Desert',
    fileName: 'IMG_5001_Giza_Pyramids_Dawn.jpg',
    title: 'Great Pyramids of Giza Desert Haze',
    dateIso: '2025-11-04T06:20:00.000Z',
    lat: 29.9792,
    lng: 31.1342,
    locationName: 'Giza Necropolis, Cairo, Egypt',
    make: 'Sony',
    model: 'ILCE-7RM5',
    lensModel: 'FE 70-200mm F2.8 GM OSS II',
    focalLength: 105,
    fNumber: 5.6,
    exposureTime: [1, 500],
    iso: 100,
    theme: 'desert',
    accent: '#f59e0b',
    motif: 'cairo',
  },
  {
    subfolder: '2025-11-Cairo-Desert',
    fileName: 'IMG_5002_Great_Sphinx_Guard.jpg',
    title: 'Great Sphinx & Khafre Pyramid',
    dateIso: '2025-11-04T09:30:00.000Z',
    lat: 29.9753,
    lng: 31.1376,
    locationName: 'Great Sphinx of Giza, Egypt',
    make: 'Sony',
    model: 'ILCE-7RM5',
    lensModel: 'FE 24-70mm F2.8 GM II',
    focalLength: 35,
    fNumber: 8.0,
    exposureTime: [1, 1000],
    iso: 100,
    theme: 'desert',
    accent: '#fbbf24',
    motif: 'cairo',
  },
  {
    subfolder: '2025-11-Cairo-Desert',
    fileName: 'IMG_5003_Citadel_Alabaster_Mosque.jpg',
    title: 'Citadel of Saladin Domes',
    dateIso: '2025-11-04T13:10:00.000Z',
    lat: 30.0287,
    lng: 31.2599,
    locationName: 'Cairo Citadel, Cairo, Egypt',
    make: 'Sony',
    model: 'ILCE-7RM5',
    lensModel: 'FE 24-70mm F2.8 GM II',
    focalLength: 24,
    fNumber: 5.6,
    exposureTime: [1, 800],
    iso: 100,
    theme: 'day',
    accent: '#eab308',
    motif: 'cairo',
  },
  {
    subfolder: '2025-11-Cairo-Desert',
    fileName: 'IMG_5004_Khan_El_Khalili_Bazaar.jpg',
    title: 'Khan el-Khalili Brass Lanterns',
    dateIso: '2025-11-04T16:40:00.000Z',
    lat: 30.0477,
    lng: 31.2623,
    locationName: 'Khan el-Khalili, Historic Cairo, Egypt',
    make: 'Sony',
    model: 'ILCE-7RM5',
    lensModel: 'FE 35mm F1.4 GM',
    focalLength: 35,
    fNumber: 1.8,
    exposureTime: [1, 160],
    iso: 640,
    theme: 'golden',
    accent: '#f97316',
    motif: 'cairo',
  },
  {
    subfolder: '2025-11-Cairo-Desert',
    fileName: 'IMG_5005_Nile_Felucca_Dusk.jpg',
    title: 'Felucca Sails on the Nile at Sunset',
    dateIso: '2025-11-04T17:55:00.000Z',
    lat: 30.0444,
    lng: 31.2290,
    locationName: 'Zamalek Nile Corniche, Cairo, Egypt',
    make: 'Sony',
    model: 'ILCE-7RM5',
    lensModel: 'FE 70-200mm F2.8 GM OSS II',
    focalLength: 85,
    fNumber: 4.0,
    exposureTime: [1, 320],
    iso: 250,
    theme: 'golden',
    accent: '#fb7185',
    motif: 'cairo',
  },
  {
    subfolder: '2025-11-Cairo-Desert',
    fileName: 'IMG_5006_Cairo_Tower_Night.jpg',
    title: 'Gezira Island & Cairo Tower Lights',
    dateIso: '2025-11-04T20:30:00.000Z',
    lat: 30.0459,
    lng: 31.2243,
    locationName: 'Cairo Tower, Zamalek, Cairo, Egypt',
    make: 'Sony',
    model: 'ILCE-7RM5',
    lensModel: 'FE 24-70mm F2.8 GM II',
    focalLength: 35,
    fNumber: 2.8,
    exposureTime: [1, 60],
    iso: 1250,
    theme: 'night',
    accent: '#f59e0b',
    motif: 'cairo',
  },

  // Unlocated Cairo shots for auto-locate: both sit inside the 16:40-17:55 bracket (75 min apart)
  {
    subfolder: '2025-11-Cairo-Desert',
    fileName: 'IMG_5007_Khan_El_Khalili_Spice_Stalls.jpg',
    title: 'Khan el-Khalili Spice Stalls at Dusk',
    dateIso: '2025-11-04T17:12:00.000Z',
    make: 'Sony',
    model: 'ILCE-7RM5',
    lensModel: 'FE 35mm F1.4 GM',
    focalLength: 35,
    fNumber: 2.8,
    exposureTime: [1, 100],
    iso: 800,
    theme: 'golden',
    accent: '#fb923c',
    motif: 'cairo',
  },
  {
    subfolder: '2025-11-Cairo-Desert',
    fileName: 'IMG_5008_Zamalek_Corniche_Lights.jpg',
    title: 'Zamalek Corniche Lights Across the Nile',
    dateIso: '2025-11-04T17:22:00.000Z',
    make: 'Sony',
    model: 'ILCE-7RM5',
    lensModel: 'FE 24-70mm F2.8 GM II',
    focalLength: 50,
    fNumber: 4.0,
    exposureTime: [1, 60],
    iso: 1000,
    theme: 'twilight',
    accent: '#f43f5e',
    motif: 'cairo',
  },

  // Day 8: 2026-01-12 — Sydney Harbour Summer
  {
    subfolder: '2026-01-Sydney-Harbour',
    fileName: 'IMG_6001_Bondi_Icebergs_Dawn.jpg',
    title: 'Bondi Icebergs Ocean Pool First Light',
    dateIso: '2026-01-12T06:10:00.000Z',
    lat: -33.8952,
    lng: 151.2743,
    locationName: 'Bondi Icebergs, Sydney, Australia',
    make: 'Leica',
    model: 'Leica Q3',
    lensModel: 'Summilux 28mm f/1.7 ASPH.',
    focalLength: 28,
    fNumber: 5.6,
    exposureTime: [1, 400],
    iso: 100,
    theme: 'dawn',
    accent: '#38bdf8',
    motif: 'sydney',
  },
  {
    subfolder: '2026-01-Sydney-Harbour',
    fileName: 'IMG_6002_Coogee_Coastal_Cliffs.jpg',
    title: 'Bondi to Coogee Sandstone Cliffs',
    dateIso: '2026-01-12T09:40:00.000Z',
    lat: -33.9036,
    lng: 151.2689,
    locationName: 'Tamarama Coastal Walk, Sydney',
    make: 'Leica',
    model: 'Leica Q3',
    lensModel: 'Summilux 28mm f/1.7 ASPH.',
    focalLength: 28,
    fNumber: 8.0,
    exposureTime: [1, 1000],
    iso: 64,
    theme: 'morning',
    accent: '#06b6d4',
    motif: 'sydney',
  },
  {
    subfolder: '2026-01-Sydney-Harbour',
    fileName: 'IMG_6003_Opera_House_Sails.jpg',
    title: 'Sydney Opera House Ceramic Sails',
    dateIso: '2026-01-12T13:15:00.000Z',
    lat: -33.8568,
    lng: 151.2153,
    locationName: 'Bennelong Point, Sydney, Australia',
    make: 'Leica',
    model: 'Leica Q3',
    lensModel: 'Summilux 28mm f/1.7 ASPH.',
    focalLength: 28,
    fNumber: 5.6,
    exposureTime: [1, 1600],
    iso: 64,
    theme: 'day',
    accent: '#0ea5e9',
    motif: 'sydney',
  },
  {
    subfolder: '2026-01-Sydney-Harbour',
    fileName: 'IMG_6004_Botanic_Garden_Lookout.jpg',
    title: 'Mrs Macquaries Chair Harbour Panorama',
    dateIso: '2026-01-12T16:50:00.000Z',
    lat: -33.8599,
    lng: 151.2225,
    locationName: 'Royal Botanic Garden, Sydney',
    make: 'Leica',
    model: 'Leica Q3',
    lensModel: 'Summilux 28mm f/1.7 ASPH.',
    focalLength: 28,
    fNumber: 4.0,
    exposureTime: [1, 800],
    iso: 100,
    theme: 'golden',
    accent: '#34d399',
    motif: 'sydney',
  },
  {
    subfolder: '2026-01-Sydney-Harbour',
    fileName: 'IMG_6005_Harbour_Bridge_Dusk.jpg',
    title: 'Sydney Harbour Bridge from Milsons Point',
    dateIso: '2026-01-12T19:30:00.000Z',
    lat: -33.8523,
    lng: 151.2108,
    locationName: 'Sydney Harbour Bridge, Australia',
    make: 'Leica',
    model: 'Leica Q3',
    lensModel: 'Summilux 28mm f/1.7 ASPH.',
    focalLength: 28,
    fNumber: 2.8,
    exposureTime: [1, 125],
    iso: 400,
    theme: 'twilight',
    accent: '#f97316',
    motif: 'sydney',
  },
  {
    subfolder: '2026-01-Sydney-Harbour',
    fileName: 'IMG_6006_Circular_Quay_Night.jpg',
    title: 'Circular Quay Ferry Trails at Night',
    dateIso: '2026-01-12T21:45:00.000Z',
    lat: -33.8615,
    lng: 151.2106,
    locationName: 'Circular Quay, Sydney, Australia',
    make: 'Leica',
    model: 'Leica Q3',
    lensModel: 'Summilux 28mm f/1.7 ASPH.',
    focalLength: 28,
    fNumber: 2.0,
    exposureTime: [1, 40],
    iso: 800,
    theme: 'night',
    accent: '#818cf8',
    motif: 'sydney',
  },

  // Unlocated, no place token in folder or file name, in the Tokyo gap with no track or bracket: stays unmatched
  {
    subfolder: 'Misc',
    fileName: 'IMG_9001.jpg',
    title: 'Unlabelled Night Snapshot',
    dateIso: '2025-03-15T02:30:00.000Z',
    make: 'Fujifilm',
    model: 'X-T5',
    lensModel: 'XF 23mm F1.4 R LM WR',
    focalLength: 23,
    fNumber: 2.0,
    exposureTime: [1, 60],
    iso: 3200,
    theme: 'night',
    accent: '#818cf8',
    motif: 'tokyo',
  },

  // Day 9: 2026-02-02 — Unlocated Studio Session (4 photos without GPS so user can test adding locations)
  {
    subfolder: '2026-02-Studio-Session',
    fileName: 'IMG_7001_Minimal_Glass_Prism.jpg',
    title: 'Studio Optical Prism Study I',
    dateIso: '2026-02-02T10:00:00.000Z',
    make: 'Hasselblad',
    model: 'X2D 100C',
    lensModel: 'XCD 90mm f/2.5V',
    focalLength: 90,
    fNumber: 4.0,
    exposureTime: [1, 160],
    iso: 64,
    theme: 'studio',
    accent: '#38bdf8',
    motif: 'studio',
  },
  {
    subfolder: '2026-02-Studio-Session',
    fileName: 'IMG_7002_Portrait_Key_Light.jpg',
    title: 'Chiaroscuro Portrait Study II',
    dateIso: '2026-02-02T12:15:00.000Z',
    make: 'Hasselblad',
    model: 'X2D 100C',
    lensModel: 'XCD 90mm f/2.5V',
    focalLength: 90,
    fNumber: 2.5,
    exposureTime: [1, 200],
    iso: 64,
    theme: 'studio',
    accent: '#f59e0b',
    motif: 'studio',
  },
  {
    subfolder: '2026-02-Studio-Session',
    fileName: 'IMG_7003_Horology_Macro_Gears.jpg',
    title: 'Mechanical Chronograph Macro III',
    dateIso: '2026-02-02T15:30:00.000Z',
    make: 'Hasselblad',
    model: 'X2D 100C',
    lensModel: 'XCD 120mm f/3.5 Macro',
    focalLength: 120,
    fNumber: 8.0,
    exposureTime: [1, 125],
    iso: 100,
    theme: 'studio',
    accent: '#a855f7',
    motif: 'studio',
  },
  {
    subfolder: '2026-02-Studio-Session',
    fileName: 'IMG_7004_Neon_Gel_Silhouette.jpg',
    title: 'Chromatic Gel Silhouette IV',
    dateIso: '2026-02-02T18:10:00.000Z',
    make: 'Hasselblad',
    model: 'X2D 100C',
    lensModel: 'XCD 55mm f/2.5V',
    focalLength: 55,
    fNumber: 2.5,
    exposureTime: [1, 160],
    iso: 200,
    theme: 'studio',
    accent: '#ec4899',
    motif: 'studio',
  },
];

function getSkyPalette(theme: DemoPhotoSpec['theme']): [string, string, string] {
  switch (theme) {
    case 'dawn':
      return ['#1e1b4b', '#701a75', '#fda4af'];
    case 'morning':
      return ['#0c4a6e', '#0284c7', '#bae6fd'];
    case 'day':
      return ['#0369a1', '#0ea5e9', '#e0f2fe'];
    case 'golden':
      return ['#31102f', '#9a3412', '#fdba74'];
    case 'twilight':
      return ['#0f172a', '#312e81', '#fb7185'];
    case 'night':
      return ['#020617', '#0f172a', '#1e293b'];
    case 'aurora':
      return ['#020617', '#064e3b', '#10b981'];
    case 'desert':
      return ['#451a03', '#b45309', '#fde68a'];
    case 'studio':
      return ['#09090b', '#18181b', '#27272a'];
  }
}

function getMotifElements(spec: DemoPhotoSpec, index: number): string {
  const seed = index * 37;
  const sunX = 220 + ((seed * 53) % 560);
  const sunY = spec.theme === 'day' || spec.theme === 'morning' ? 160 : 280;

  switch (spec.motif) {
    case 'tokyo':
      return `
        <!-- Mt Fuji & Tokyo Skyline Silhouette -->
        <path d="M 0 500 L 180 420 L 290 290 L 350 290 L 470 430 L 960 490 L 960 640 L 0 640 Z" fill="#0f172a" opacity="0.65" />
        <!-- Pagoda / Tower & City Blocks -->
        <rect x="120" y="340" width="55" height="220" fill="#090d16" />
        <rect x="190" y="380" width="70" height="180" fill="#090d16" />
        <polygon points="560,160 540,480 580,480" fill="${spec.accent}" opacity="0.85" />
        <rect x="640" y="310" width="85" height="250" fill="#090d16" />
        <rect x="745" y="350" width="65" height="210" fill="#090d16" />
        <!-- Glowing Neon Signs -->
        <rect x="655" y="340" width="18" height="75" rx="4" fill="${spec.accent}" opacity="0.9" />
        <rect x="208" y="405" width="32" height="14" rx="3" fill="#38bdf8" opacity="0.85" />
        <circle cx="${sunX}" cy="${sunY}" r="58" fill="${spec.accent}" opacity="0.75" />
      `;
    case 'paris':
      return `
        <circle cx="${sunX}" cy="${sunY}" r="52" fill="${spec.accent}" opacity="0.7" />
        <!-- Eiffel Tower & Haussmann Rooftops -->
        <path d="M 455 130 L 465 130 L 485 330 L 535 490 L 495 490 L 475 420 L 445 420 L 425 490 L 385 490 L 435 330 Z" fill="#0f172a" />
        <rect x="60" y="425" width="310" height="90" fill="#0f172a" opacity="0.9" />
        <rect x="550" y="420" width="350" height="95" fill="#0f172a" opacity="0.9" />
      `;
    case 'iceland':
      return `
        ${
          spec.theme === 'aurora'
            ? `<path d="M 40 160 Q 260 60, 480 180 T 920 120" fill="none" stroke="#4ade80" stroke-width="42" stroke-linecap="round" opacity="0.45" />
               <path d="M 80 230 Q 320 120, 560 220 T 900 180" fill="none" stroke="#2dd4bf" stroke-width="26" stroke-linecap="round" opacity="0.4" />`
            : `<circle cx="${sunX}" cy="${sunY}" r="46" fill="${spec.accent}" opacity="0.75" />`
        }
        <!-- Kirkjufell & Dramatic Highland Peaks -->
        <polygon points="80,500 280,210 470,500" fill="#0f172a" opacity="0.9" />
        <polygon points="380,500 620,250 880,500" fill="#1e293b" opacity="0.85" />
        <!-- Waterfall Stream -->
        <rect x="268" y="340" width="24" height="160" fill="#e0f2fe" opacity="0.7" />
      `;
    case 'ny':
      return `
        <circle cx="${sunX}" cy="${sunY}" r="50" fill="${spec.accent}" opacity="0.7" />
        <!-- Manhattan Skyline & Suspension Bridge -->
        <rect x="90" y="270" width="60" height="230" fill="#090d16" />
        <rect x="165" y="320" width="55" height="180" fill="#0f172a" />
        <polygon points="310,120 315,190 285,190 285,500 345,500 345,190 315,190" fill="#090d16" />
        <rect x="370" y="250" width="75" height="250" fill="#0f172a" />
        <rect x="465" y="290" width="65" height="210" fill="#090d16" />
        <path d="M 560 500 L 660 240 L 700 240 L 800 500" fill="none" stroke="${spec.accent}" stroke-width="8" opacity="0.85" />
      `;
    case 'cairo':
      return `
        <circle cx="${sunX}" cy="${sunY}" r="64" fill="${spec.accent}" opacity="0.85" />
        <!-- Great Pyramids of Giza & Desert Dunes -->
        <polygon points="140,490 330,220 520,490" fill="#451a03" />
        <polygon points="330,220 520,490 425,490" fill="#78350f" />
        <polygon points="430,490 610,260 790,490" fill="#451a03" />
        <polygon points="680,490 790,350 900,490" fill="#78350f" />
      `;
    case 'sydney':
      return `
        <circle cx="${sunX}" cy="${sunY}" r="52" fill="${spec.accent}" opacity="0.8" />
        <!-- Harbour Bridge Arch & Opera House Sails -->
        <path d="M 80 480 Q 290 250, 500 480" fill="none" stroke="#0f172a" stroke-width="18" />
        <path d="M 540 480 Q 560 350, 630 480 Z" fill="#f8fafc" opacity="0.92" />
        <path d="M 605 480 Q 630 330, 710 480 Z" fill="#e2e8f0" opacity="0.92" />
        <path d="M 685 480 Q 710 370, 775 480 Z" fill="#cbd5e1" opacity="0.92" />
      `;
    case 'studio':
      return `
        <!-- Studio Geometric Light & Prism -->
        <circle cx="480" cy="300" r="150" fill="${spec.accent}" opacity="0.22" />
        <polygon points="480,140 330,430 630,430" fill="none" stroke="${spec.accent}" stroke-width="8" opacity="0.9" />
        <circle cx="480" cy="325" r="56" fill="${spec.accent}" opacity="0.7" />
      `;
  }
}

const DEMO_GENERATOR_VERSION = 3;

function buildPhotoSvg(spec: DemoPhotoSpec, index: number): string {
  const [skyTop, skyMid, skyBot] = getSkyPalette(spec.theme);
  const motifSvg = getMotifElements(spec, index);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${skyTop}" />
        <stop offset="58%" stop-color="${skyMid}" />
        <stop offset="100%" stop-color="${skyBot}" />
      </linearGradient>
      <linearGradient id="water" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#090d16" stop-opacity="0.82" />
        <stop offset="100%" stop-color="#020617" stop-opacity="0.98" />
      </linearGradient>
    </defs>
    <rect width="960" height="640" fill="url(#sky)" />
    ${motifSvg}
    <!-- Horizon Water / Foreground Reflection -->
    <rect x="0" y="485" width="960" height="155" fill="url(#water)" />
    <line x1="0" y1="485" x2="960" y2="485" stroke="${spec.accent}" stroke-opacity="0.45" stroke-width="2" />
    <!-- Subtle Water Shimmer Lines -->
    <line x1="180" y1="518" x2="780" y2="518" stroke="${spec.accent}" stroke-opacity="0.22" stroke-width="2" stroke-linecap="round" />
    <line x1="260" y1="548" x2="700" y2="548" stroke="${spec.accent}" stroke-opacity="0.16" stroke-width="2" stroke-linecap="round" />
    <line x1="340" y1="578" x2="620" y2="578" stroke="${spec.accent}" stroke-opacity="0.10" stroke-width="2" stroke-linecap="round" />
  </svg>`;
}

const DEMO_ROUTE_SAMPLE_STEP_MS = 5 * 60 * 1000;
const DEMO_ROUTE_MAX_GAP_MS = 6 * 60 * 60 * 1000;

interface DemoRouteAnchor {
  utcMs: number;
  lat: number;
  lng: number;
}

// Trip key is the first folder segment, so both Iceland subfolders form one trip
function buildDemoRouteSegments(): Array<[DemoRouteAnchor, DemoRouteAnchor]> {
  const anchorsByTrip = new Map<string, DemoRouteAnchor[]>();
  for (const spec of DEMO_PHOTO_SPECS) {
    if (spec.lat === undefined || spec.lng === undefined) continue;
    const trip = spec.subfolder.split(/[\\/]/)[0];
    const anchors = anchorsByTrip.get(trip) ?? [];
    anchors.push({ utcMs: Date.parse(spec.dateIso), lat: spec.lat, lng: spec.lng });
    anchorsByTrip.set(trip, anchors);
  }

  const segments: Array<[DemoRouteAnchor, DemoRouteAnchor]> = [];
  for (const anchors of anchorsByTrip.values()) {
    anchors.sort((a, b) => a.utcMs - b.utcMs);
    for (let i = 1; i < anchors.length; i++) {
      const gapMs = anchors[i].utcMs - anchors[i - 1].utcMs;
      if (gapMs > 0 && gapMs <= DEMO_ROUTE_MAX_GAP_MS) {
        segments.push([anchors[i - 1], anchors[i]]);
      }
    }
  }
  return segments;
}

const DEMO_ROUTE_SEGMENTS = buildDemoRouteSegments();

function interpolateDemoRoute(start: DemoRouteAnchor, end: DemoRouteAnchor, utcMs: number): { lat: number; lng: number } {
  const alpha = (utcMs - start.utcMs) / (end.utcMs - start.utcMs);
  return {
    lat: start.lat + (end.lat - start.lat) * alpha,
    lng: start.lng + (end.lng - start.lng) * alpha,
  };
}

export function demoRoutePointAt(utcMs: number): { lat: number; lng: number } | null {
  for (const [start, end] of DEMO_ROUTE_SEGMENTS) {
    if (utcMs >= start.utcMs && utcMs <= end.utcMs) {
      return interpolateDemoRoute(start, end, utcMs);
    }
  }
  return null;
}

export function buildDemoSampleTrackGpx(): string {
  const samples = new Map<number, { lat: number; lng: number }>();
  for (const [start, end] of DEMO_ROUTE_SEGMENTS) {
    for (let utcMs = start.utcMs; utcMs < end.utcMs; utcMs += DEMO_ROUTE_SAMPLE_STEP_MS) {
      samples.set(utcMs, interpolateDemoRoute(start, end, utcMs));
    }
    samples.set(end.utcMs, { lat: end.lat, lng: end.lng });
  }

  const trkpts = Array.from(samples.entries())
    .sort(([a], [b]) => a - b)
    .map(
      ([utcMs, point]) =>
        `      <trkpt lat="${point.lat.toFixed(6)}" lon="${point.lng.toFixed(6)}"><time>${new Date(utcMs).toISOString()}</time></trkpt>`
    );

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="MyAlbum" xmlns="http://www.topografix.com/GPX/1/1">',
    '  <trk>',
    '    <trkseg>',
    ...trkpts,
    '    </trkseg>',
    '  </trk>',
    '</gpx>',
    '',
  ].join('\n');
}

export async function ensureDemoPhotosGenerated(sampleRootDir: string): Promise<void> {
  const markerFile = path.join(sampleRootDir, '.myalbum-demo-ready.json');
  try {
    const raw = await fs.readFile(markerFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === DEMO_GENERATOR_VERSION && parsed.count === DEMO_PHOTO_SPECS.length) {
      return;
    }
  } catch {
    // Proceed to generate
  }

  await fs.mkdir(sampleRootDir, { recursive: true });

  const locationHints: Record<string, string> = {};

  for (let i = 0; i < DEMO_PHOTO_SPECS.length; i++) {
    const spec = DEMO_PHOTO_SPECS[i];
    const dirPath = path.join(sampleRootDir, spec.subfolder);
    await fs.mkdir(dirPath, { recursive: true });

    const fullPath = path.join(dirPath, spec.fileName);
    const relKey = path.posix.join(spec.subfolder.replace(/\\/g, '/'), spec.fileName);
    if (spec.locationName) {
      locationHints[relKey] = spec.locationName;
    }

    const svgStr = buildPhotoSvg(spec, i);
    const rawJpeg = await sharp(Buffer.from(svgStr))
      .resize(960, 640, { fit: 'cover' })
      .jpeg({ quality: 88 })
      .toBuffer();

    const exifInput: RawExifInput = {
      make: spec.make,
      model: spec.model,
      lensModel: spec.lensModel,
      dateTimeOriginal: spec.dateIso,
      exposureTime: spec.exposureTime,
      fNumber: spec.fNumber,
      iso: spec.iso,
      focalLength: spec.focalLength,
      width: 960,
      height: 640,
      lat: spec.lat,
      lng: spec.lng,
    };

    const finalJpeg = injectExifIntoJpeg(rawJpeg, exifInput);
    await fs.writeFile(fullPath, finalJpeg);

    const ts = new Date(spec.dateIso);
    await fs.utimes(fullPath, ts, ts);
  }

  await fs.writeFile(
    markerFile,
    JSON.stringify(
      {
        version: DEMO_GENERATOR_VERSION,
        generatedAt: new Date().toISOString(),
        count: DEMO_PHOTO_SPECS.length,
        locationHints,
      },
      null,
      2
    ),
    'utf8'
  );
}
