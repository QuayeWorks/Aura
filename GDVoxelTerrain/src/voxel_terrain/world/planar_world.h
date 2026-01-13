#ifndef JAR_PLANAR_WORLD_H
#define JAR_PLANAR_WORLD_H

#include "world.h"

class JarPlanarWorld : public JarWorld
{
    GDCLASS(JarPlanarWorld, JarWorld);

  private:
    float surface_height = 0.0f;
    Vector3 normal = Vector3(0, 1, 0);

  public:
    float get_surface_height() const { return surface_height; }
    void set_surface_height(float value) { surface_height = value; }

    Vector3 get_normal() const { return normal; }
    void set_normal(const Vector3 &value) { normal = value; }

    Vector3 get_gravity_vector(const Vector3 &position) const override
    {
        return normal * -get_gravity_strength();
    }

    float get_height(const Vector3 &position) const override
    {
        return (position).dot(normal) - surface_height;
    }

  protected:
    static void _bind_methods()
    {
        ClassDB::bind_method(D_METHOD("get_surface_height"), &JarPlanarWorld::get_surface_height);
        ClassDB::bind_method(D_METHOD("set_surface_height", "value"), &JarPlanarWorld::set_surface_height);
        ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "surface_height"), "set_surface_height", "get_surface_height");

        ClassDB::bind_method(D_METHOD("get_normal"), &JarPlanarWorld::get_normal);
        ClassDB::bind_method(D_METHOD("set_normal", "value"), &JarPlanarWorld::set_normal);
        ADD_PROPERTY(PropertyInfo(Variant::VECTOR3, "normal"), "set_normal", "get_normal");
    }
};

#endif // JAR_PLANAR_WORLD_H
