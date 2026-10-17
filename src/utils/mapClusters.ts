import Supercluster from 'supercluster';
import type { PhotoItem } from '../types/photo.ts';

export interface SinglePhotoClusterNode {
  isCluster: false;
  id: string;
  lat: number;
  lng: number;
  photo: PhotoItem;
}

export interface MultiPhotoClusterNode {
  isCluster: true;
  id: string;
  clusterId: number;
  pointCount: number;
  lat: number;
  lng: number;
  expansionZoom: number;
  samplePhotos: PhotoItem[];
  allPhotos: PhotoItem[];
}

export type MapClusterNode = SinglePhotoClusterNode | MultiPhotoClusterNode;

interface PointProps {
  photoId: string;
  photo: PhotoItem;
}

export function createPhotoSupercluster(locatedPhotos: PhotoItem[], radius = 64, maxZoom = 16) {
  const index = new Supercluster<PointProps>({
    radius,
    maxZoom,
    minPoints: 2,
  });

  const points: Array<Supercluster.PointFeature<PointProps>> = locatedPhotos
    .filter((p): p is PhotoItem & { location: NonNullable<PhotoItem['location']> } => p.location !== null)
    .map((photo) => ({
      type: 'Feature',
      properties: {
        photoId: photo.id,
        photo,
      },
      geometry: {
        type: 'Point',
        coordinates: [photo.location.lng, photo.location.lat],
      },
    }));

  index.load(points);
  return index;
}

export function queryMapClusters(
  index: Supercluster<PointProps>,
  bbox: [number, number, number, number],
  zoom: number
): MapClusterNode[] {
  const safeZoom = Math.max(0, Math.min(20, Math.floor(zoom)));
  const rawClusters = index.getClusters(bbox, safeZoom);

  return rawClusters.map((feature) => {
    const [lng, lat] = feature.geometry.coordinates;
    const props = feature.properties as any;

    if (props.cluster) {
      const clusterId = props.cluster_id as number;
      const pointCount = props.point_count as number;
      let expansionZoom = safeZoom + 2;
      try {
        expansionZoom = index.getClusterExpansionZoom(clusterId);
      } catch {
        // default fallback
      }
      const leaves = index.getLeaves(clusterId, Infinity);
      const allPhotos = leaves.map((l) => l.properties.photo);
      return {
        isCluster: true,
        id: `cluster-${clusterId}`,
        clusterId,
        pointCount,
        lat,
        lng,
        expansionZoom,
        samplePhotos: allPhotos.slice(0, 3),
        allPhotos,
      };
    }

    const photo = props.photo as PhotoItem;
    return {
      isCluster: false,
      id: `photo-${photo.id}`,
      lat,
      lng,
      photo,
    };
  });
}
