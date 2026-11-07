export const tripLabel = (trip: { number?: number }) => trip.number ? `Рейс №${trip.number}` : 'Рейс';
