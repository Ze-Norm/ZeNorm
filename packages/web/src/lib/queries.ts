import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { orpc } from "@/orpc";

/** Every map with its project and status, newest first; the live layer refetches it. */
export function useMapOverviews() {
  return useQuery(orpc.map.overviews.queryOptions());
}

/** One map with its project, status, activity and messages; the live layer refetches it. */
export function useMapOverview(mapId: string) {
  return useQuery(orpc.map.overview.queryOptions({ input: { mapId } }));
}

/**
 * `hatch.send`: stores the message and returns the overview, which replaces the
 * map's cached one (its messages list the new one queued or working); the Inbox's reads refetch.
 */
export function useSendHatchMessage() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.hatch.send.mutationOptions({
      onSuccess: (detail, input) => {
        queryClient.setQueryData(
          orpc.map.overview.queryKey({ input: { mapId: input.mapId } }),
          detail,
        );
        // Not awaited: the composer empties once the server took the message, not after every
        // project's refetch, which would empty the next message typed in the meantime.
        void Promise.all(
          [orpc.map.overviews.key(), orpc.project.get.key()].map((queryKey) =>
            queryClient.invalidateQueries({ queryKey }),
          ),
        );
      },
    }),
  );
}
