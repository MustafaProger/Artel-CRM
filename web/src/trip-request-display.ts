/** Legacy delivery places sometimes use their full address as their name. */
export function getDeliveryPlaceDisplay(name?: string | null, address?: string | null) {
  const placeName = name?.trim() || ''
  const streetAddress = address?.trim() || ''
  const normalize = (value: string) => value.replace(/\s+/g, ' ')
  return {
    name: placeName && streetAddress && normalize(placeName) !== normalize(streetAddress) ? placeName : null,
    address: streetAddress || placeName,
  }
}
